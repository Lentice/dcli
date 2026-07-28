const { spawnSync } = require('child_process');
const path = require('path');
const { parseFindings } = require('../findings');
const { executeRun } = require('./run');

const DIFF_CAP_BYTES = 100 * 1024;
const UNTRACKED_SIZE_LIMIT = 50 * 1024;

function executeReview({ store, adapter, repoKey, repoRoot, prompt, hardTimeoutSec, group, label, model, access, reasoningEffort, variant, effort, admission, reviewScope, rangeBase, rangeHead, paths, includeUntracked, embedDiff, intent, focus }) {
  if (access && access !== 'read-only') {
    const err = new Error('--access must be "read-only" for review. Got: ' + access);
    err.exitCode = 2;
    throw err;
  }

  const scope = reviewScope || 'working';

  const diffInfo = generateDiff({ repoRoot, scope, rangeBase, rangeHead, paths, includeUntracked, embedDiff });

  const reviewPrompt = buildReviewPrompt({ diffInfo, intent, focus, userPrompt: prompt || '' });

  const result = executeRun({
    store, adapter, repoKey, repoRoot,
    prompt: reviewPrompt,
    hardTimeoutSec, group, label, model,
    access: 'read-only',
    reasoningEffort, variant, effort, admission,
  });

  return result.then(output => {
    const findingsResult = parseFindings(output.text || '');
    output.envelope.findings_status = findingsResult.status;
    output.envelope.findings = findingsResult.data;
    output.findings = findingsResult;
    return output;
  });
}

function generateDiff({ repoRoot, scope, rangeBase, rangeHead, paths, includeUntracked, embedDiff }) {
  const info = { diff: '', truncated: false, totalBytes: 0, truncationInfo: null, untrackedWarning: null, untrackedFiles: [] };

  if (embedDiff === false) {
    info.diff = '(diff embedding disabled)';
    return info;
  }

  const gitArgs = ['diff'];
  if (scope === 'staged') gitArgs.push('--staged');
  else if (scope === 'range') {
    if (!rangeBase || !rangeHead) {
      const err = new Error('--range requires format <base>..<head>');
      err.exitCode = 2;
      throw err;
    }
    gitArgs.push(`${rangeBase}..${rangeHead}`);
  }

  if (paths && paths.length > 0) {
    gitArgs.push('--');
    for (const p of paths) gitArgs.push(p);
  }

  const result = spawnSync('git', gitArgs, {
    cwd: repoRoot,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: DIFF_CAP_BYTES * 2,
  });

  let diffText = result.stdout || '';
  info.totalBytes = Buffer.byteLength(diffText, 'utf8');

  if (info.totalBytes > DIFF_CAP_BYTES) {
    info.truncated = true;
    const truncatedLen = Buffer.byteLength(diffText.slice(0, DIFF_CAP_BYTES), 'utf8');
    info.truncationInfo = `Diff truncated: ${info.totalBytes} bytes total, showing first ${truncatedLen} bytes. Remaining content was dropped.`;
    diffText = diffText.slice(0, DIFF_CAP_BYTES) + '\n[... diff truncated ...]\n';
  }

  if (!includeUntracked) {
    const untracked = getUntrackedFiles(repoRoot, paths);
    if (untracked.length > 0) {
      info.untrackedFiles = untracked;
      info.untrackedWarning = `Warning: ${untracked.length} untracked file(s) not included in diff. Use --include-untracked to include them.`;
    }
  } else {
    const untrackedContent = getUntrackedContent(repoRoot, paths);
    if (untrackedContent) {
      info.untrackedFiles = untrackedContent.files;
      if (diffText.length > 0) diffText += '\n';
      diffText += untrackedContent.content;
      if (untrackedContent.truncated) {
        const truncMsg = `\n[Untracked files truncated: showing ${untrackContent.shownBytes} of ${untrackedContent.totalBytes} bytes]\n`;
        diffText += truncMsg;
      }
    }
  }

  info.diff = diffText;
  return info;
}

function getUntrackedFiles(repoRoot, paths) {
  const args = ['ls-files', '--others', '--exclude-standard'];
  if (paths && paths.length > 0) {
    args.push('--');
    for (const p of paths) args.push(p);
  }
  const result = spawnSync('git', args, { cwd: repoRoot, encoding: 'utf8', windowsHide: true });
  if (result.status !== 0 || !result.stdout) return [];
  return result.stdout.trim().split('\n').filter(Boolean);
}

function getUntrackedContent(repoRoot, paths) {
  const files = getUntrackedFiles(repoRoot, paths);
  if (files.length === 0) return null;

  let content = '--- Untracked files ---\n';
  let totalBytes = 0;
  let truncated = false;
  const resultFiles = [];

  for (const file of files) {
    if (totalBytes >= UNTRACKED_SIZE_LIMIT) {
      truncated = true;
      break;
    }
    resultFiles.push(file);
    const filePath = path.join(repoRoot, file);
    try {
      const fileContent = require('fs').readFileSync(filePath, 'utf8');
      const fileBytes = Buffer.byteLength(fileContent, 'utf8');
      if (totalBytes + fileBytes > UNTRACKED_SIZE_LIMIT) {
        const available = UNTRACKED_SIZE_LIMIT - totalBytes;
        content += `\`\`\`\n${fileContent.slice(0, available)}\n\`\`\`\n`;
        totalBytes += available;
        truncated = true;
        break;
      }
      content += `### ${file}\n\`\`\`\n${fileContent}\n\`\`\`\n`;
      totalBytes += fileBytes;
    } catch {
      content += `### ${file}\n(unreadable)\n`;
    }
  }

  return { files: resultFiles, content, totalBytes, truncated, shownBytes: totalBytes };
}

function buildReviewPrompt({ diffInfo, intent, focus, userPrompt }) {
  let prompt = '';

  if (userPrompt && userPrompt.trim()) {
    prompt += userPrompt.trim() + '\n\n';
  }

  prompt += '# Code Review Request\n\n';

  if (intent) {
    prompt += `Intent: ${intent}\n\n`;
  }
  if (focus) {
    prompt += `Focus: ${focus}\n\n`;
  }

  prompt += '**This intent is context, not evidence of correctness. Base your findings on the actual diff below.**\n\n';
  prompt += 'Rules:\n';
  prompt += '- Provide evidence against the actual diff for each finding.\n';
  prompt += '- Do not suggest edits to the code.\n';
  prompt += '- Order findings by severity (critical first, then important, then minor).\n';
  prompt += '- Include exactly one findings appendix using the marker: <!-- dcli:findings -->\n\n';

  if (diffInfo.untrackedWarning) {
    prompt += diffInfo.untrackedWarning + '\n\n';
  }

  if (diffInfo.truncationInfo) {
    prompt += diffInfo.truncationInfo + '\n\n';
  }

  prompt += '## Diff\n\n```diff\n' + diffInfo.diff + '\n```\n';

  return prompt;
}

module.exports = { executeReview, generateDiff, buildReviewPrompt, getUntrackedFiles, DIFF_CAP_BYTES };
