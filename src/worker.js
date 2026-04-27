import fastq from 'fastq';
import requestMap from './requestMap.js';

class Worker {
  constructor(id, handler, concurrency = 1) {
    this.id = id;
    this._handler = handler;
    this._active = false;
    this.queue = fastq.promise(this._process.bind(this), concurrency);
  }
  async _process(task) {
    this._active = true;
    const requests = requestMap.readAllByJobId(task.jobControl.Id);
    const hasInputChanged = this.hasInputChanged(task);
    const isAsyncCallInProcess = this.isAsyncCallInProcess(task, requests);
    // Scenario 1: hasInputChanged && !isAsyncCallInProcess
    if (hasInputChanged && !isAsyncCallInProcess) {
      // fall through to try/catch/finally
    }
    // Scenario 2: !hasInputChanged && isAsyncCallInProcess
    if (!hasInputChanged && isAsyncCallInProcess) {
      const waitingOnUuid = this.getRequestToWaitOn(task, requests);
      requestMap.update(task.recordUuid, 'Waiting', waitingOnUuid);
      this._active = false;
      return undefined;
    }
    // Scenario 3: !hasInputChanged && !isAsyncCallInProcess
    if (!hasInputChanged && !isAsyncCallInProcess) {
      requestMap.update(task.recordUuid, 'Skipping', null);
      this._active = false;
      return undefined;
    }
    // Scenario 4: hasInputChanged && isAsyncCallInProcess
    if (hasInputChanged && isAsyncCallInProcess) {
      requestMap.update(task.recordUuid, 'Processing', null);
      const running = requestMap.readAllByJobId(task.jobControl.Id, 'Processing');
      if (running.length > 0) {
        const taskToCancel = running[0];
        requestMap.update(taskToCancel.uuid, 'Cancelling', null);
      }
      requestMap.update(task.recordUuid, 'Processing', null);
      this._active = false;
      return undefined;
    }
    try {
      const result = await this._handler(task, this.id);
      return { ...result };
    } catch (err) {
      requestMap.update(task.recordUuid, 'Error');
      err._recordUuid = task.recordUuid;
      throw err;
    } finally {
      this._active = false;
      requestMap.update(task.recordUuid, 'Completed');
    }
  }
  hasInputChanged(task) {
    return true;
  }
  isAsyncCallInProcess(task, requests) {
    return requests.filter(r => r.jobId === task.jobControl.Id).length > 1;
  }
  getRequestToWaitOn(task, requests) {
    const found = requests.find(r => r.status === 'Processing' && r.jobId === task.jobControl.Id);
    return found ? found.uuid : null;
  }
  get pending() {
    return this.queue.length() + (this._active ? 1 : 0);
  }
  accept(task) {
    return this.queue.push(task);
  }
  subscribe(pool) {
    this._pool = pool;
  }
}
export default Worker;
