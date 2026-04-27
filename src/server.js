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
      let pollForResult = setInterval(() => {
        if (workers.filter(w => w.pending > 0).length === 0) {
          clearInterval(pollForResult);
        }
      }, pollInterval);
      jobPromise.then(result => {
        clearInterval(pollForResult);
        if (!result) {
          const entry = requestMap.readByUuid(recordUuid);
          if (entry?.status === 'Waiting') {
            requestMap.removeByUuid(recordUuid);
            res.writeHead(202, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ jobId: jobControl.Id, status: 'Waiting', message: 'Request is waiting on another in-flight job.' }));
            return;
          }
          if (entry?.status === 'Skipping') {
            requestMap.removeByUuid(recordUuid);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ jobId: jobControl.Id, status: 'Skipping', message: 'Request skipped (no input change, no async in process).' }));
            return;
          }
        }
        requestMap.removeByUuid(recordUuid);
        const { _recordUuid, ...responseData } = result;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(responseData));
      }).catch(err => {
        clearInterval(pollForResult);
        if (err._recordUuid) requestMap.update(err._recordUuid, 'Error');
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Internal server error', details: err.message }));
      });
    });
    return;
  }
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
});

server.listen(PORT);
