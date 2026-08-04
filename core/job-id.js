const crypto = require('crypto');

const ALPHANUM = 'abcdefghijklmnopqrstuvwxyz0123456789';

function generateJobId() {
  const now = new Date();
  const iso = now.toISOString();
  const ts = iso.replace(/[-:]/g, '').split('.')[0] + 'Z';

  let rand = '';
  for (let i = 0; i < 8; i++) {
    rand += ALPHANUM[crypto.randomInt(ALPHANUM.length)];
  }

  return `${ts}-${rand}`;
}

// Exactly the shape generateJobId() produces: `<UTC compact timestamp>-<8
// lowercase alphanumerics>`. Anything wider would accept ids dcli cannot mint,
// which is the opposite of what the check is for. The calendar validity of the
// timestamp is not checked: a well-shaped id that names no job is correctly
// "not found" (exit 3), and only the shape distinguishes a foreign id.
const JOB_ID_PATTERN = /^\d{8}T\d{6}Z-[a-z0-9]{8}$/;

// An id minted by some other runtime can never name a dcli job, and reporting
// it as "not found" sends the caller hunting through a job store that was never
// going to hold it.
function isJobId(id) {
  return typeof id === 'string' && JOB_ID_PATTERN.test(id);
}

module.exports = { generateJobId, isJobId, JOB_ID_PATTERN };
