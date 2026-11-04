const groups = window.yumiGroups;
const app = document.querySelector('#app');
const adminGroups = ['express', 'admin', 'warehouse'];
const isDesktop = (group, id) => adminGroups.includes(group) || id.startsWith('admin-');
const url = (group, id) => '?screen=' + group + ':' + id;
const png = (group, id) => 'png/' + group + '/' + id + '.png';
const icon = (name, size = 20) => {
  const paths = {
    mark: '<rect x="6" y="4" width="5" height="7" rx="2.5"/><rect x="13" y="4" width="5" height="7" rx="2.5"/><rect x="6" y="13" width="5" height="7" rx="2.5"/><rect x="13" y="13" width="5" height="7" rx="2.5"/>',
    home: '<path d="m3 10 9-7 9 7v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M9 21v-7h6v7"/>',
    bag: '<rect x="4" y="8" width="16" height="13" rx="2"/><path d="M8 9V7a4 4 0 0 1 8 0v2"/>',
    person: '<circle cx="12" cy="8" r="4"/><path d="M4 21v-2a8 6 0 0 1 16 0v2"/>',
    search: '<circle cx="10.5" cy="10.5" r="5.5"/><path d="m15 15 4 4"/>',
    box: '<path d="m12 3 9 5v8l-9 5-9-5V8zM3 8l9 5 9-5m-9 5v8M7 5.8l9 5"/>',
    sheet: '<rect x="5" y="3" width="14" height="18" rx="2"/><path d="M8 8h8m-8 4h8m-8 4h5"/>',
    arrow: '<path d="m14 6-6 6 6 6"/>',
    next: '<path d="m9 6 6 6-6 6"/>',
    check: '<path d="m5 12 5 5L19 8"/>',
    alert: '<circle cx="12" cy="12" r="9"/><path d="M12 7v6m0 3v1"/>',
    dots: '<path d="M6 12h.1m5.9 0h.1m5.9 0h.1"/>',
    grid: '<rect x="4" y="4" width="6" height="6" rx="1"/><rect x="14" y="4" width="6" height="6" rx="1"/><rect x="4" y="14" width="6" height="6" rx="1"/><rect x="14" y="14" width="6" height="6" rx="1"/>',
  };
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || paths.sheet}</svg>`;
};
const brand = () => `<span class="brand"><i>${icon('mark', 21)}</i><strong>玉米百货</strong></span>`;
const start = {points:'store', express:'overview', retail:'home', admin:'overview', warehouse:'stock', picker:'home', rider:'tasks', states:'loading'};
const nav = {
  points: [['home','商城','store'],['sheet','兑换订单','redemptions'],['person','我的','account']],
  retail: [['home','首页','home'],['grid','分类','category'],['bag','购物车','cart'],['sheet','订单','orders']],
  picker: [['home','作业','home'],['sheet','任务','queue'],['box','库存','stock']],
  rider: [['sheet','我的任务','tasks']],
  express: [['home','工作台','overview'],['person','积分账户','accounts'],['check','积分审批','approvals'],['bag','兑换商品','reward-list'],['sheet','兑换订单','orders'],['box','快递发货','dispatch'],['alert','售后反馈','support'],['grid','快递范围','coverage'],['check','发布检查','release']],
  admin: [['home','工作台','overview'],['bag','商品管理','catalog'],['grid','分类管理','categories'],['sheet','订单管理','orders'],['alert','支付核查','payments'],['box','骑手调度','dispatch'],['check','零售售后','refunds'],['sheet','对账与报表','reconcile'],['person','员工与权限','staff'],['grid','小区服务设置','service']],
  warehouse: [['box','库存总览','stock'],['grid','库位管理','locations'],['bag','收货记录','receipts'],['sheet','移位上架','move'],['check','盘点任务','counts'],['alert','报损与隔离','loss'],['sheet','库存流水','ledger'],['box','拣货与出库','picks'],['sheet','退货验收','return']],
};
const parentNav = {
  points: {reward:'store',confirm:'store',addresses:'account','address-form':'account',balance:'account',shipped:'redemptions',pending:'redemptions',cancel:'redemptions',canceled:'redemptions',feedback:'redemptions','feedback-log':'redemptions'},
  express: {ledger:'accounts',grant:'accounts',correction:'accounts',approval:'approvals','reward-edit':'reward-list',order:'orders',print:'dispatch',ship:'dispatch','ship-result':'dispatch',shipped:'dispatch','sent-list':'dispatch','tracking-edit':'dispatch',reply:'support'},
  admin: {product:'catalog',sku:'catalog','category-edit':'categories',order:'orders','payment-review':'payments','payment-note':'payments',assign:'dispatch',delivery:'dispatch',exceptions:'dispatch',resolve:'dispatch',returns:'dispatch',withdraw:'dispatch',refund:'refunds',difference:'reconcile',report:'reconcile','staff-edit':'staff'},
  warehouse: {batches:'stock','location-edit':'locations',receipt:'receipts','receipt-detail':'receipts','receipt-reversal':'receipts',count:'counts',isolation:'loss',ready:'picks',shortage:'picks',outbound:'picks'},
};

function screen(group, id, title, subtitle, kind, action = '', source = '') {
  const groupName = groups.find(item => item[0] === group)[1];
  const desktop = isDesktop(group, id);
  const mode = group === 'states' ? (desktop ? 'express' : 'points') : group;
  const rows = source ? source.split(';').map(row => row.split('|')) : [];
  const link = (to) => to.includes(':') ? url(...to.split(':')) : url(mode, to);
  const linkText = (value = '') => {
    const [label, target] = value.split('›');
    return target ? `<a href="${link(target)}">${label}${icon('next', 14)}</a>` : label;
  };
  const [buttonText, buttonTarget] = action.split('>');
  const button = action ? `<a class="button" href="${link(buttonTarget)}">${buttonText}${icon('next', 16)}</a>` : '';
  const menu = (nav[mode] || []).map(([symbol, name, target]) => `<a class="${target === (parentNav[mode]?.[id] || id) ? 'active' : ''}" href="${url(mode,target)}">${icon(symbol, 18)}<span>${name}</span></a>`).join('');
  const blocks = () => rows.map(([label, value, note], index) => `<article class="block">
    <span class="block-label">${linkText(label)}</span><strong>${linkText(value)}</strong>
    ${note ? `<p>${linkText(note)}</p>` : ''}${kind === 'timeline' ? `<i class="dot ${index === 0 ? 'first' : ''}"></i>` : ''}
    </article>`).join('');
  const field = ([label, value]) => `<label class="field"><span>${label}</span><input value="${value}" ${/密码/.test(label) ? 'type="password"' : ''} readonly></label>`;
  const products = ['纯棉方巾','便携抽纸','原色陶瓷杯','温和洗手液'];
  const prices = mode === 'retail' ? ['¥9.00','¥5.90','¥16.80','¥12.00'] : ['480 积分','320 积分','820 积分','650 积分'];
  const specs = ['燕麦色 · 单件','原色 · 单盒','米白 · 1只','无香 · 300 ml'];
  const cards = () => `<div class="product-grid">${products.map((name, i) => `<${i === 0 ? 'a href="' + url(mode,mode === 'retail' ? 'product' : 'reward') + '"' : 'article'} class="product-tile">
    <div class="photo photo-${i}"></div><div class="product-copy"><strong>${name}</strong><small>${specs[i]}</small><b>${prices[i]}</b>${i === 0 ? '<i>↗</i>' : ''}</div></${i === 0 ? 'a' : 'article'}>`).join('')}</div>`;
  const pill = (label) => `<span class="tag ${/待|草稿/.test(label) ? 'pending' : ''}">${label}</span>`;
  const table = (checkbox = false) => `<div class="table-wrap"><table><thead><tr>${checkbox ? '<th><input type="checkbox" aria-label="选择全部"></th>' : ''}${rows[0].map(label => `<th>${label}</th>`).join('')}</tr></thead>
    <tbody>${rows.slice(1).map((row, i) => `<tr>${checkbox ? `<td><input type="checkbox" aria-label="选择订单 ${i+1}" ${i === 0 ? 'checked' : ''}></td>` : ''}${row.map((value, j) => `<td>${['状态','支付','履约'].includes(rows[0][j]) ? pill(value) : linkText(value)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
  const filter = () => `<div class="filters"><label>${icon('search', 17)} <input placeholder="${mode === 'warehouse' ? '查找商品、批次或库位' : kind === 'dispatch' ? '输入订单编号' : '搜索当前列表'}" aria-label="搜索"></label><span>全部状态 ⌄</span>${kind === 'dispatch' ? '<span>全部下单日期 ⌄</span>' : ''}</div>`;

  let content;
  switch (kind) {
    case 'store':
      content = `<div class="storetop">${brand()}<span class="tag">${mode === 'retail' ? '社区配送' : '积分兑换'}</span></div>
        ${mode === 'retail' ? `<a class="store-strip" href="${url(mode,'area')}">示例花园 · 配送范围 ${icon('next',14)}</a><a class="store-strip" href="${url(mode,'search')}">${icon('search',16)} 搜索日用百货</a>` : ''}
        <section class="hero"><small>YUMI DAILY</small><h1>${mode === 'retail' ? '小区里的<br>日用百货' : '用积分，换<br>日常好物'}</h1><span>${mode === 'retail' ? '好物在身边' : '把好物寄到家'}</span></section>
        ${mode === 'points' ? `<a class="balance-strip" href="${url(mode,'balance')}"><span>可用积分 <b>2,480</b></span><span>积分明细 ${icon('next',15)}</span></a>` : ''}
        <div class="section-head"><h2>${mode === 'points' ? '精选可兑换' : '日常好物'}</h2><small>社区好物选集</small></div>${cards()}`;
      break;
    case 'catalog':
      content = `<label class="mobile-search">${icon('search')}<input aria-label="搜索商品" placeholder="搜索日用百货"></label><div class="tabs"><b>全部</b><span>家居日用</span><span>纸品清洁</span><span>个护</span></div>${cards()}`;
      break;
    case 'product':
      content = `<div class="photo photo-0 product-hero"></div><div class="product-title"><div><span class="tag">家居日用</span><h2>${subtitle}</h2></div><b>${prices[0]}</b></div>${blocks()}`;
      break;
    case 'login':
      content = `<div class="login-card">${brand()}<h2>${title}</h2><p>${subtitle}</p>${rows.map(field).join('')}${button}<small>设计预览 · 示例账号</small></div>`;
      break;
    case 'balance':
      content = `<div class="balance-panel"><span>可用积分</span><strong>2,480</strong><small>YUMI DAILY · 积分账户</small></div><h2 class="section-title">积分明细</h2>${blocks()}`;
      break;
    case 'account':
      content = `<div class="balance-panel"><span>玉米百货会员</span><strong>林女士</strong><small>当前微信账号</small></div>${blocks()}`;
      break;
    case 'dashboard':
      content = `<div class="stats">${rows.map(([label, value, note], i) => `<article><i>${icon(['box','sheet','check','alert'][i])}</i><small>${label}</small><strong>${value}</strong><p>${linkText(note)}</p></article>`).join('')}</div>
        ${desktop ? `<section class="dashboard-note"><div><small>YUMI WORKSPACE / 01</small><h2>${mode === 'express' ? '今日发货流程' : '关注待办与异常'}</h2><p>${mode === 'express' ? '筛选待发货订单，打印配货单，交快递后录入运单。' : '按角色进入工作队列，先核对异常，再处理下一步。'}</p></div>${button}</section>` : ''}`;
      break;
    case 'table':
    case 'dispatch':
      content = `<section class="table-card">
        ${kind === 'dispatch' ? `<div class="tabs"><b>待发货 <em>12</em></b><a href="${url(mode,'sent-list')}">已发货</a><a href="${url(mode,'orders')}">全部兑换订单</a></div>` : ''}
        ${filter()}${table(kind === 'dispatch')}<footer><span>${kind === 'dispatch' ? '已选 1 单 · 每批最多 20 单' : '当前展示 ' + (rows.length - 1) + ' 条样例'}</span><span class="tag">第 1 页</span></footer></section>
        ${kind === 'dispatch' ? '<aside class="hint">ⓘ &nbsp; 配货单用于核对商品与收件信息。包裹交快递后，逐单录入运单并确认发货。</aside>' : ''}`;
      break;
    case 'print':
      content = `<div class="print-layout"><article class="paper">${brand()}<h2>兑换订单配货单</h2><p>快递发货 · YM-EX-1104-01</p><hr><p><b>收件信息</b>　林女士 · 138****0000</p><p>广东省深圳市南山区 · 示例路18号</p>${table()}<p>合计 1 件 · 480 积分</p><hr><small>商家配货使用 · 配货单非快递面单 · 设计样例</small></article><article class="block"><span class="block-label">打印设置</span><strong>A4 纵向</strong><p>每单一页 · 本次预览 1 单</p><p>正式操作在打印前重新校验订单。</p><button class="button" id="print-sample" type="button">打印样例 ${icon('sheet', 16)}</button></article></div>`;
      break;
    case 'form':
      content = `<section class="form-card">${rows.map(field).join('')}${desktop ? button : ''}</section>`;
      break;
    case 'loading':
      content = `<div class="skeleton banner"></div><div class="product-grid">${'<div class="skeleton"></div>'.repeat(4)}</div>`;
      break;
    case 'state':
    case 'result':
    case 'confirm':
      content = `<section class="state-card"><i>${icon(kind === 'result' ? 'check' : id === 'empty' ? 'box' : 'alert', 32)}</i><h2>${subtitle}</h2></section>${blocks()}`;
      break;
    case 'gate':
      content = `<div class="hint">ⓘ &nbsp; ${subtitle}</div><section class="gate-grid">${blocks()}</section>`;
      break;
    case 'split':
      content = `<section class="split">${blocks()}</section>`;
      break;
    case 'pick':
      content = `<div class="pick-progress"><strong>逐项核对</strong><span id="pick-label">1 / 3 件</span><progress id="pick-progress" max="3" value="1"></progress></div>
        <section class="stack">${rows.slice(0, 3).map(([location, item, detail], index) => `<label class="block pick-item"><span class="tag">${location}</span><strong>${item}</strong><p>${detail}</p><input type="checkbox" aria-label="核对${item}" ${index === 0 ? 'checked' : ''}></label>`).join('')}
        <article class="block"><span class="block-label">发现缺货或破损</span><strong>${linkText(rows[3][1])}</strong></article></section>`;
      break;
    default:
      content = `<section class="stack ${kind}">${blocks()}</section>`;
  }
  const titleBlock = `<div><h1>${title}</h1><p>${subtitle}</p></div>`;
  if (desktop) {
    return `<div class="desktop ${kind}"><aside class="sidebar">${brand()}<small>YUMI WORKSPACE</small><nav>${menu}</nav><a class="back-atlas" href="index.html">← 返回设计图集</a></aside>
    <div class="work"><header class="top"><span>${groupName} &nbsp; / &nbsp; <b>${title}</b></span><span><i class="sample">设计样例</i>　社区仓　<span class="avatar">玉</span></span></header>
    <div class="desk-body"><div class="page-head">${titleBlock}${['table','dispatch','split','timeline','gate','print'].includes(kind) ? button : ''}</div>${content}</div>
    <footer class="desk-footer">YUMI WORKSPACE &nbsp; / &nbsp; 2026.11</footer></div></div>`;
  }
  const noTitle = ['store','product','login','state','result','confirm'].includes(kind);
  return `<div class="phone ${mode} ${kind}"><div class="statusbar"><b>9:41</b><span>▴▴▴　▮▮▮</span></div>
    <header class="mobile-top"><a aria-label="返回角色首页" href="${url(mode,start[mode])}">${icon('arrow')}</a><strong>${mode === 'points' && kind === 'store' ? '积分商城' : title}</strong><a aria-label="返回设计图集" class="capsule" href="index.html">${icon('dots', 18)}<span>◉</span></a></header>
    <div class="mobile-body">${!noTitle ? `<div class="mobile-intro"><span class="eyebrow">${mode === 'rider' ? '配送作业' : mode === 'picker' ? '仓库作业' : '玉米百货'}</span>${titleBlock}</div>` : ''}${content}</div>
    ${action && kind !== 'login' ? `<div class="mobile-cta">${kind === 'pick' ? '<span class="button pick-disabled" aria-disabled="true">核对全部商品后继续</span>' : ''}${button}</div>` : `<nav class="mobile-nav">${menu}</nav>`}
    <div class="home-indicator"></div></div>`;
}

function gallery() {
  app.className = 'atlas';
  const count = groups.reduce((total, group) => total + group[3].length, 0);
  app.innerHTML = `<header class="atlas-head">${brand()}<span>产品设计图集 / 2026.11</span></header>
  <section class="atlas-hero"><small>YUMI DAILY / PRODUCT DESIGN</small><h1>玉米百货<br>全流程 UI 图集</h1><p>${count} 张独立界面 · 8 个图组 · 首发与后续分轨</p><a class="button" href="#points">浏览首发界面 ${icon('next',16)}</a></section>
  <nav class="atlas-nav">${groups.map(([id, title]) => `<a href="#${id}">${title}</a>`).join('')}</nav>
  <div class="atlas-notice">全部数据和商品图片为设计样例。点击卡片进入可跳转预览，点击 PNG 查看原图。</div>
  ${groups.map(([group, title, phase, screens], i) => `<section class="atlas-section" id="${group}">
    <header><span>0${i+1} / ${screens.length} 张</span><h2>${title}</h2><p>${phase}</p></header>
    <div class="atlas-grid">${screens.map(([id, name]) => `<article class="atlas-tile ${isDesktop(group,id) ? 'wide' : ''}"><a href="${url(group,id)}" aria-label="预览${name}"><img loading="lazy" src="${png(group,id)}" alt="${name}"></a><div><a href="${url(group,id)}">${name}</a><a href="${png(group,id)}">PNG ↗</a></div></article>`).join('')}</div>
  </section>`).join('')}`;
}

const requested = new URLSearchParams(location.search).get('screen');
if (requested) {
  const [group, id] = requested.split(':');
  const data = groups.find(item => item[0] === group)?.[3].find(item => item[0] === id);
  if (data) {
    document.title = data[1] + ' · 玉米百货';
    document.body.className = 'single';
    app.innerHTML = screen(group, ...data);
    app.querySelector('#print-sample')?.addEventListener('click', () => window.print());
    if (data[3] === 'pick') {
      const boxes = [...app.querySelectorAll('.pick-item input')];
      const progress = app.querySelector('#pick-progress');
      const label = app.querySelector('#pick-label');
      const disabled = app.querySelector('.pick-disabled');
      const next = app.querySelector('.mobile-cta a');
      const update = () => {
        const count = boxes.filter(box => box.checked).length;
        progress.value = count;
        label.textContent = count + ' / ' + boxes.length + ' 件';
        disabled.hidden = count === boxes.length;
        next.hidden = count !== boxes.length;
      };
      for (const box of boxes) box.addEventListener('change', update);
      update();
    }
  } else {
    gallery();
  }
} else {
  gallery();
}
