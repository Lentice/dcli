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

// The shape generateJobId() produces: `<UTC compact timestamp>-<8 lowercase
// alphanumerics>`. The suffix length is deliberately loose here — the
// timestamp prefix is what discriminates a dcli id from a foreign one, and a
// check that also polices the suffix width would reject nothing extra that
// matters while making the id format harder to widen later.
const JOB_ID_PATTERN = /^\d{8}T\d{6}Z-[a-z0-9]{4,16}$/;

// An id minted by some other runtime can never name a dcli job, and reporting
// it as "not found" sends the caller hunting through a job store that was never
// going to hold it.
function isJobId(id) {
  return typeof id === 'string' && JOB_ID_PATTERN.test(id);
}

module.exports = { generateJobId, isJobId, JOB_ID_PATTERN };
