const path = require('node:path');
const fs = require('node:fs/promises');

const TEMPLATE_PATH = path.join(__dirname, 'templates', 'delivery-email.md');

let cachedTemplate = null;
async function loadTemplate() {
  if (cachedTemplate) return cachedTemplate;
  cachedTemplate = await fs.readFile(TEMPLATE_PATH, 'utf8');
  return cachedTemplate;
}

function fillTemplate(template, vars) {
  return template.replace(/\{(\w+)\}/g, (m, key) => (key in vars ? String(vars[key]) : m));
}

async function renderDeliveryEmail({ channelName, customerName, downloadUrl, videoCount, wordCount }) {
  const template = await loadTemplate();
  const filled = fillTemplate(template, {
    ChannelName: channelName || 'Your channel',
    CustomerName: (customerName && customerName.trim()) ? customerName.trim() : 'there',
    DownloadURL: downloadUrl || '{DownloadURL}',
    VideoCount: videoCount ?? '?',
    WordCount: wordCount ?? '?',
  });

  // First "Subject:" line is metadata; everything else is the body.
  const lines = filled.split('\n');
  let subject = '';
  let bodyStart = 0;
  for (let i = 0; i < lines.length; i++) {
    if (/^subject:\s*/i.test(lines[i])) {
      subject = lines[i].replace(/^subject:\s*/i, '').trim();
      bodyStart = i + 1;
      while (bodyStart < lines.length && lines[bodyStart].trim() === '') bodyStart++;
      break;
    }
  }
  const body = lines.slice(bodyStart).join('\n').trim() + '\n';
  return { subject, body };
}

module.exports = { renderDeliveryEmail };
