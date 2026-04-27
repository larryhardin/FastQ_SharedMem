// SharedArrayBuffer-backed in-memory map for tracking job status
import { randomUUID } from 'crypto';

const RECORD_SIZE = 109;
const MAX_SLOTS = 1000;
const FIELD_SIZE = 36;
const STATUS = Object.freeze({
  EMPTY: 0,
  PROCESSING: 1,
  COMPLETED: 2,
  WAITING: 3,
  SKIPPING: 4,
  CANCELLING: 5,
  CANCELED: 6,
  ERROR: 7
});
const STATUS_LABEL = [
  null,
  'Processing',
  'Completed',
  'Waiting',
  'Skipping',
  'Cancelling',
  'Canceled',
  'Error'
];

const sab = new SharedArrayBuffer(RECORD_SIZE * MAX_SLOTS);
const buf = new Uint8Array(sab);

function _offset(index) {
  return index * RECORD_SIZE;
}
function _readField(index, fieldOff) {
  const off = _offset(index) + fieldOff;
  let str = '';
  for (let i = 0; i < FIELD_SIZE; ++i) {
    const byte = buf[off + i];
    if (byte === 0) break;
    str += String.fromCharCode(byte);
  }
  return str.length ? str : null;
}
function _writeField(index, fieldOff, value) {
  const off = _offset(index) + fieldOff;
  for (let i = 0; i < FIELD_SIZE; ++i) {
    buf[off + i] = 0;
  }
  for (let i = 0; i < Math.min(FIELD_SIZE, value.length); ++i) {
    buf[off + i] = value.charCodeAt(i);
  }
}
function _statusCode(status) {
  if (typeof status === 'number') {
    if (status >= 0 && status < STATUS_LABEL.length) return status;
  } else if (typeof status === 'string') {
    const idx = STATUS_LABEL.indexOf(status);
    if (idx !== -1) return idx;
  }
  throw new Error('Invalid status: ' + status);
}
function _findEmpty() {
  for (let i = 0; i < MAX_SLOTS; ++i) {
    if (Atomics.load(buf, _offset(i) + 108) === STATUS.EMPTY) return i;
  }
  return -1;
}
function _findSlotByJobId(jobId) {
  for (let i = 0; i < MAX_SLOTS; ++i) {
    if (Atomics.load(buf, _offset(i) + 108) !== STATUS.EMPTY) {
      const jid = _readField(i, 36);
      if (jid === jobId) return i;
    }
  }
  return -1;
}
function _findSlotByUuid(uuid) {
  for (let i = 0; i < MAX_SLOTS; ++i) {
    if (Atomics.load(buf, _offset(i) + 108) !== STATUS.EMPTY) {
      const recUuid = _readField(i, 0);
      if (recUuid === uuid) return i;
    }
  }
  return -1;
}
function add(jobId, status, waitingOnUuid = null) {
  if (typeof jobId !== 'string' || jobId.length > FIELD_SIZE) throw new Error('Invalid jobId');
  if (waitingOnUuid && waitingOnUuid.length > FIELD_SIZE) throw new Error('Invalid waitingOnUuid');
  const idx = _findEmpty();
  if (idx === -1) throw new Error('No empty slot');
  const recordUuid = randomUUID();
  _writeField(idx, 0, recordUuid);
  _writeField(idx, 36, jobId);
  _writeField(idx, 72, waitingOnUuid || '');
  Atomics.store(buf, _offset(idx) + 108, _statusCode(status));
  return recordUuid;
}
function read(jobId) {
  for (let i = 0; i < MAX_SLOTS; ++i) {
    if (Atomics.load(buf, _offset(i) + 108) !== STATUS.EMPTY) {
      const jid = _readField(i, 36);
      if (jid === jobId) {
        return {
          uuid: _readField(i, 0),
          jobId: jid,
          waitingOnUuid: _readField(i, 72),
          status: STATUS_LABEL[Atomics.load(buf, _offset(i) + 108)]
        };
      }
    }
  }
  return null;
}
function readByUuid(uuid) {
  for (let i = 0; i < MAX_SLOTS; ++i) {
    if (Atomics.load(buf, _offset(i) + 108) !== STATUS.EMPTY) {
      const recUuid = _readField(i, 0);
      if (recUuid === uuid) {
        return {
          uuid: recUuid,
          jobId: _readField(i, 36),
          waitingOnUuid: _readField(i, 72),
          status: STATUS_LABEL[Atomics.load(buf, _offset(i) + 108)]
        };
      }
    }
  }
  return null;
}
function readAllByJobId(jobId, readForStatus = null) {
  const arr = [];
  for (let i = 0; i < MAX_SLOTS; ++i) {
    if (Atomics.load(buf, _offset(i) + 108) !== STATUS.EMPTY) {
      const jid = _readField(i, 36);
      if (jid === jobId) {
        const statusIdx = Atomics.load(buf, _offset(i) + 108);
        if (readForStatus == null || STATUS_LABEL[statusIdx] === readForStatus) {
          arr.push({
            uuid: _readField(i, 0),
            jobId: jid,
            waitingOnUuid: _readField(i, 72),
            status: STATUS_LABEL[statusIdx]
          });
        }
      }
    }
  }
  return arr;
}
function update(uuid, status, waitingOnUuid = null) {
  const idx = _findSlotByUuid(uuid);
  if (idx === -1) throw new Error('Record not found');
  Atomics.store(buf, _offset(idx) + 108, _statusCode(status));
  if (waitingOnUuid !== null) _writeField(idx, 72, waitingOnUuid || '');
}
function remove(jobId) {
  const idx = _findSlotByJobId(jobId);
  if (idx === -1) return false;
  for (let i = 0; i < RECORD_SIZE; ++i) buf[_offset(idx) + i] = 0;
  return true;
}
function removeByUuid(uuid) {
  const idx = _findSlotByUuid(uuid);
  if (idx === -1) return false;
  for (let i = 0; i < RECORD_SIZE; ++i) buf[_offset(idx) + i] = 0;
  return true;
}
function check(payload) {
  let count = 0;
  for (let i = 0; i < MAX_SLOTS; ++i) {
    if (Atomics.load(buf, _offset(i) + 108) !== STATUS.EMPTY) {
      const jid = _readField(i, 36);
      if (jid === payload.jobControl.Id) ++count;
    }
  }
  return count;
}
function list() {
  const arr = [];
  for (let i = 0; i < MAX_SLOTS; ++i) {
    if (Atomics.load(buf, _offset(i) + 108) !== STATUS.EMPTY) {
      arr.push({
        uuid: _readField(i, 0),
        jobId: _readField(i, 36),
        waitingOnUuid: _readField(i, 72),
        status: STATUS_LABEL[Atomics.load(buf, _offset(i) + 108)]
      });
    }
  }
  return arr;
}
export default {
  add,
  read,
  readByUuid,
  update,
  remove,
  removeByUuid,
  check,
  list,
  readAllByJobId,
  STATUS,
  STATUS_LABEL
};
