// 部署自測：確認 swarm-server 會由 ~/.perplexity_secrets load key（loadEnv strip export）
// + runResearch 喺 deployed 環境真 call 到 Perplexity。唔 print key value（只 print 長度）。
const path = require('path');
const os = require('os');
require('../lib/env').loadEnv(path.join(os.homedir(), '.perplexity_secrets'));
console.log('PERPLEXITY_API_KEY set:', !!process.env.PERPLEXITY_API_KEY, '| len:', (process.env.PERPLEXITY_API_KEY || '').length);

const { runResearch } = require('../lib/perplexity-research');
(async () => {
  const r = await runResearch(
    'HKDSE Chemistry 化學科考試結構同評核',
    ['卷一卷二題型同比重', '必修課題範圍', '校本評核點計分'],
    { runId: 'deploytest', logDir: '/tmp/pplx-deploytest' }
  );
  console.log('research ok:', r.ok, '| used:', r.used + '/' + r.budget, '| textLen:', (r.text || '').length,
    '| cites:', (r.citations || []).length, '| est$:', r.estCost, '| err:', r.error || 'none');
})();
