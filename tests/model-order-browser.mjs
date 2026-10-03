import assert from 'node:assert/strict';

const { chromium } = await import(process.env.CODEY_PLAYWRIGHT_MODULE || 'playwright');
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  const drag = (scope, source, target) => scope.getByRole('group', { name: `拖动排序 ${source}`, exact: true })
    .dragTo(scope.getByRole('group', { name: `拖动排序 ${target}`, exact: true }));
  await page.goto(`http://127.0.0.1:1432/codey/tests/model-order-browser.html${process.env.CODEY_TEST_SHADOW ? '?shadow' : ''}`);
  // 首次进入卡片即可调整，无需先打开同步弹窗。
  await drag(page, 'gpt-old', 'gpt-new');
  await page.getByRole('button', { name: '保存顺序', exact: true }).click();
  assert.deepEqual(await page.evaluate(() => window.savedRequests.at(-1).args.thirdPartyModels), ['gpt-new', 'gpt-old']);
  await drag(page, 'gpt-new', 'gpt-old');
  await page.getByRole('button', { name: '取消排序', exact: true }).click();
  assert.deepEqual(await page.evaluate(() => window.savedRequests.at(-1).args.thirdPartyModels), ['gpt-new', 'gpt-old']);
  await page.reload();
  await page.getByRole('button', { name: '打开同步弹窗', exact: true }).click();
  const dialog = page.getByRole('dialog');
  const models = () => dialog.getByRole('checkbox', { name: /^当前 provider 支持 / }).evaluateAll(
    nodes => nodes.map(node => node.getAttribute('aria-label').replace('当前 provider 支持 ', '')));
  assert.deepEqual(await models(), ['gpt-new', 'gpt-old', 'custom']);
  assert.equal(await dialog.getByRole('button', { name: /^(上移|下移) / }).count(), 0);
  await dialog.getByRole('group', { name: '拖动排序 gpt-new', exact: true }).press('ArrowUp');
  assert.deepEqual(await models(), ['gpt-new', 'gpt-old', 'custom']);
  await drag(dialog, 'gpt-new', 'gpt-old');
  assert.deepEqual(await models(), ['gpt-old', 'gpt-new', 'custom']);
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  assert.equal(await page.evaluate(() => window.savedRequests?.length || 0), 0);
  await page.getByRole('button', { name: '打开同步弹窗', exact: true }).click();
  await dialog.getByRole('checkbox', { name: '当前 provider 支持 gpt-new', exact: true }).press('Space');
  await dialog.getByRole('checkbox', { name: '当前 provider 支持 gpt-new', exact: true }).press('Space');
  await dialog.getByRole('button', { name: '保存模型声明', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
  let saved = await page.evaluate(() => window.savedRequests.at(-1).args);
  assert.deepEqual(saved.thirdPartyModels, ['gpt-new', 'gpt-old']);
  assert.equal(saved.modelOrderMode, 'official');
  await drag(page, 'gpt-new', 'gpt-old');
  await page.getByRole('button', { name: '保存顺序', exact: true }).click();
  await page.getByRole('button', { name: '保存顺序', exact: true }).and(page.locator(':disabled')).waitFor();
  saved = await page.evaluate(() => window.savedRequests.at(-1).args);
  assert.deepEqual(saved.thirdPartyModels, ['gpt-old', 'gpt-new']);
  assert.equal(saved.modelOrderMode, 'manual');
  assert.equal(saved.modelContexts, undefined);
  assert.equal(saved.supportsAutoReview, undefined);
  await page.getByRole('button', { name: '打开同步弹窗', exact: true }).click();
  assert.deepEqual(await models(), ['gpt-old', 'gpt-new', 'custom']);
  await dialog.getByRole('button', { name: '恢复官方排序', exact: true }).click();
  assert.deepEqual(await models(), ['gpt-new', 'gpt-old', 'custom']);
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  await page.getByRole('button', { name: '恢复官方排序', exact: true }).click();
  await page.evaluate(() => { window.failSave = true; });
  await page.getByRole('button', { name: '保存顺序', exact: true }).click();
  await page.getByText('保存失败', { exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: '保存顺序', exact: true }).count(), 1);
  await page.getByRole('button', { name: '取消排序', exact: true }).click();
  assert.deepEqual(JSON.parse(await page.locator('#saved').textContent()).selectedModelsByProvider['provider-fingerprint'], ['gpt-old', 'gpt-new']);
  await page.evaluate(() => { window.failSave = false; window.updateModelState({ upstreamModels: ['brand-new', 'gpt-new', 'custom', 'gpt-old'] }); });
  await page.getByRole('button', { name: '打开同步弹窗', exact: true }).click();
  assert.deepEqual(await models(), ['gpt-old', 'gpt-new', 'brand-new', 'custom']);
  await dialog.getByRole('textbox', { name: '搜索其他模型', exact: true }).fill('gpt');
  await drag(dialog, 'gpt-new', 'gpt-old');
  await dialog.getByRole('textbox', { name: '搜索其他模型', exact: true }).fill('');
  assert.deepEqual(await models(), ['gpt-new', 'gpt-old', 'brand-new', 'custom']);
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  await page.evaluate(() => window.updateModelState({ officialModelOrder: [] }));
  await page.getByRole('button', { name: '打开同步弹窗', exact: true }).click();
  assert.deepEqual(await models(), ['gpt-old', 'gpt-new', 'brand-new', 'custom']);
  assert.equal(await dialog.getByRole('button', { name: '恢复官方排序', exact: true }).isDisabled(), true);
  await dialog.getByText('官方排序暂不可用，保留当前顺序。', { exact: true }).waitFor();
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  await page.evaluate(() => window.updateModelState({ officialModelOrder: ['gpt-new', 'gpt-old'],
    upstreamModels: ['custom-a', 'custom-b', 'gpt-old', 'relay/gpt-new'],
    thirdPartyModels: ['custom-b', 'custom-a', 'gpt-old', 'relay/gpt-new'] }));
  await page.getByRole('button', { name: '打开同步弹窗', exact: true }).click();
  await dialog.getByRole('button', { name: '恢复官方排序', exact: true }).click();
  assert.deepEqual(await models(), ['relay/gpt-new', 'gpt-old', 'custom-a', 'custom-b']);
  await dialog.getByRole('button', { name: '保存模型声明', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
  await drag(page, 'custom-b', 'custom-a');
  await page.getByRole('button', { name: '恢复官方排序', exact: true }).click();
  await page.getByRole('button', { name: '保存顺序', exact: true }).click();
  await page.getByRole('button', { name: '保存顺序', exact: true }).and(page.locator(':disabled')).waitFor();
  assert.deepEqual(await page.evaluate(() => window.savedRequests.at(-1).args.thirdPartyModels),
    ['relay/gpt-new', 'gpt-old', 'custom-a', 'custom-b']);
  if (process.env.CODEY_TEST_SCREENSHOT) await page.locator('.provider-model-group').first().screenshot({ path: process.env.CODEY_TEST_SCREENSHOT });
  console.log('模型排序浏览器交互检查通过');
} finally {
  await browser.close();
}
