import assert from 'node:assert/strict';

export function realWechatAppId(value) {
  return (
    typeof value === 'string' && /^wx[a-f0-9]{16}$/.test(value) && value !== 'wx0000000000000000'
  );
}

// AppID is public. AppSecret must never be added to project/build metadata.
export function wechatProjectAppId(projects, target, expectedAppId) {
  assert.ok(
    projects.length && projects.every((p) => p && typeof p.appid === 'string'),
    '小程序工程缺少AppID配置。',
  );
  // Local previews keep existing import configs intact and use the consumer source.
  const id = target === 'local' ? projects.at(-1).appid : projects[0].appid;
  if (target === 'device')
    assert.ok(
      projects.every((p) => p.appid === id),
      '小程序各工程的AppID不一致，请先同步工程配置。',
    );
  if (target === 'device')
    assert.ok(realWechatAppId(id), '真实微信构建需要小程序自己的AppID，不能使用游客或占位AppID。');
  if (expectedAppId !== undefined)
    assert.ok(
      realWechatAppId(expectedAppId) && id === expectedAppId,
      '工程AppID与本次指定的微信AppID不一致。',
    );
  return id;
}
