import dotenv from 'dotenv';
import http from 'http';
import fastq from 'fastq';
import { createPool } from './index.js';
import requestMap from './requestMap.js';
dotenv.config();

const PORT = (() => {
  const p = parseInt(process.env.PORT, 10);
  if (!Number.isInteger(p) || p < 1 || p > 65535) throw new Error('Invalid PORT');
  return p;
})();

async function handler(task, workerId) {
  const { jobControl, payload } = task;
  const timeToWait = Math.min(parseInt(jobControl.timeToWait, 10) || 0, 60000);
  await new Promise(res => setTimeout(res, timeToWait));
  return {
    jobId: jobControl.Id,
    workerId,
    processedAt: new Date().toISOString()
  };
}

function validateRequestBody(parsed) {
  if (!parsed || typeof parsed !== 'object') return 'Invalid JSON';
  const { jobControl, payload } = parsed;
  if (!jobControl || typeof jobControl !== 'object') return 'Missing jobControl';
  if (!jobControl.Id) return 'Missing jobControl.Id';
  if (!jobControl.requestedAt) return 'Missing jobControl.requestedAt';
  if (!jobControl.timeToWait) return 'Missing jobControl.timeToWait';
  if (!payload || typeof payload !== 'object') return 'Missing or invalid payload';
  return null;
}

const { workers, NUM_WORKERS } = createPool(handler);
const jobQueue = fastq.promise(async (task) => {
  const worker = workers.find(w => !w._active) ?? workers[0];
  return worker.accept(task);
}, NUM_WORKERS);

const server = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/pricing/requests/control') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      let parsed;
      try {
        parsed = JSON.parse(body);
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON' }));
        return;
      }
      const err = validateRequestBody(parsed);
      if (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err }));
        return;
      }
      const { jobControl, payload } = parsed;
      const recordUuid = requestMap.add(jobControl.Id, 'Processing');
      const jobPromise = jobQueue.push({ jobControl, payload, recordUuid });
      const timeToWait = Math.min(parseInt(jobControl.timeToWait, 10) || 0, 60000);
      const pollInterval = Math.max(10, Math.floor(timeToWait / 4));
      const maxPolls = Math.ceil(timeToWait / pollInterval);
      let pollCount = 1;
      let responseSent = false;
      function safeRespond(statusCode, body) {
        if (!responseSent) {
          responseSent = true;
          res.writeHead(statusCode, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(body));
        }
      }
      function pollJob() {
        console.log(`Polling ${pollCount}/${maxPolls} for job ${jobControl.Id}`);
        const entry = requestMap.readByUuid(recordUuid);
        if (!entry) {
          console.log(`Job ${jobControl.Id} is no longer running (detected in interval). Returning 200.`);
          safeRespond(200, { jobId: jobControl.Id, status: 'Completed', message: 'Job completed while waiting.' });
          return;
        }
        if (pollCount >= maxPolls) {
          console.log(`Job ${jobControl.Id} is still running after all intervals. Returning 202.`);
          safeRespond(202, { jobId: jobControl.Id, status: 'Waiting', message: 'Job is still running after waiting period.' });
          return;
        }
        pollCount++;
        setTimeout(pollJob, pollInterval);
      }
      setTimeout(pollJob, pollInterval);
      jobPromise.then(result => {
        // polling is handled by setTimeout, nothing to clear
        if (responseSent) return;
        if (!result) {
          const entry = requestMap.readByUuid(recordUuid);
          if (entry?.status === 'Waiting') {
            requestMap.removeByUuid(recordUuid);
            safeRespond(202, { jobId: jobControl.Id, status: 'Waiting', message: 'Request is waiting on another in-flight job.' });
            return;
          }
          if (entry?.status === 'Skipping') {
            requestMap.removeByUuid(recordUuid);
            safeRespond(200, { jobId: jobControl.Id, status: 'Skipping', message: 'Request skipped (no input change, no async in process).' });
            return;
          }
          // If result is undefined and not handled above, return 202 as a fallback
          safeRespond(202, { jobId: jobControl.Id, status: 'Waiting', message: 'No result returned, job may still be processing.' });
          return;
        }
        requestMap.removeByUuid(recordUuid);
        const { _recordUuid, ...responseData } = result;
        safeRespond(200, responseData);
      }).catch(err => {
        // polling is handled by setTimeout, nothing to clear
        if (responseSent) return;
        if (err._recordUuid) requestMap.update(err._recordUuid, 'Error');
        safeRespond(500, { error: 'Internal server error', details: err.message });
      });
    });
    return;
  }
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
});

server.listen(PORT, () => {
  const address = server.address();
  const host = address.address === '::' ? 'localhost' : address.address;
  console.log(`Server is running at http://${host}:${address.port}/`);
});
