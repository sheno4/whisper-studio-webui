import assert from 'node:assert/strict';
import test from 'node:test';

import { extractLinksFromText, normalizeLinkCandidate } from '../src/shared/link-parser';

test('extracts the real Douyin URL from a full Markdown share message', () => {
  const shareText = String.raw`4.17 :1pm Y\@z.GV dnq:/ 12/11 蛋黄到底能不能吃，一天吃几个？反式脂肪从哪里来，它的危害有多大？关于血脂与饮食的那些问题，一条视频讲清楚！# 健康静距离# 视频播客扶持计划# 抖来聊聊# 健康科普知识破圈# 走进生命医线  [https://v.douyin.com/Or7mQoN\_pBM/](https://v.douyin.com/Or7mQoN_pBM/) 复制此链接，打开Dou音搜索，直接观看视频！`;

  assert.deepEqual(extractLinksFromText(shareText), ['https://v.douyin.com/Or7mQoN_pBM/']);
});

test('unescapes Markdown punctuation in a plain Douyin URL', () => {
  assert.deepEqual(extractLinksFromText(String.raw`复制 https://v.douyin.com/Or7mQoN\_pBM/ 打开抖音`), [
    'https://v.douyin.com/Or7mQoN_pBM/'
  ]);
});

test('uses a Markdown link target instead of its display text', () => {
  assert.deepEqual(
    extractLinksFromText('[查看视频](https://www.youtube.com/watch?v=example123)'),
    ['https://www.youtube.com/watch?v=example123']
  );
});

test('preserves a mixed batch containing a Douyin short link', () => {
  const links = [
    'https://www.youtube.com/watch?v=Pvve-3YFqNc',
    'https://v.douyin.com/AbCd123/',
    'https://www.bilibili.com/video/BV1xx411c7mD/'
  ];
  assert.deepEqual(extractLinksFromText(links.join('\n')), links);
});

test('does not create tasks from prose or unsupported schemes', () => {
  for (const text of ['这个视频怎么失败了', 'hello world', '请帮我 下载视频', 'ftp://example.com/video.mp4']) {
    assert.deepEqual(extractLinksFromText(text), [], text);
  }
});

test('accepts real protocol-free domains and bare Bilibili video ids', () => {
  assert.deepEqual(extractLinksFromText('example.com/video.mp4'), ['https://example.com/video.mp4']);
  assert.deepEqual(extractLinksFromText('youtu.be/example123'), ['https://youtu.be/example123']);
  assert.deepEqual(extractLinksFromText('BV1xx411c7mD'), ['https://www.bilibili.com/video/BV1xx411c7mD/']);
});

test('only normalizes video ids on actual Douyin domains', () => {
  assert.equal(normalizeLinkCandidate('https://www.douyin.com/?modal_id=123456789'), 'https://www.douyin.com/video/123456789');
  assert.equal(normalizeLinkCandidate('https://notdouyin.com/?modal_id=123456789'), 'https://notdouyin.com/?modal_id=123456789');
});
