import Taro from '@tarojs/taro';

let nextFilter: { keyword: string; category: string } | undefined;
let nextRedemptionView: { status?: string; service?: 'after-sales' } | undefined;

export async function openRewards(keyword = '', category = '') {
  const filter = { keyword, category };
  nextFilter = filter;
  try {
    await Taro.navigateTo({ url: '/pages/rewards/index' });
  } catch {
    if (nextFilter === filter) nextFilter = undefined;
    void Taro.showToast({ title: '暂时无法打开积分商城', icon: 'none' });
  }
}

export function takeRewardFilter() {
  const filter = nextFilter;
  nextFilter = undefined;
  return filter;
}

export async function openRedemptions(view: { status?: string; service?: 'after-sales' } = {}) {
  nextRedemptionView = view;
  try {
    await Taro.switchTab({ url: '/pages/redemptions/index' });
  } catch {
    nextRedemptionView = undefined;
    void Taro.showToast({ title: '暂时无法打开兑换订单', icon: 'none' });
  }
}

export function takeRedemptionView() {
  const view = nextRedemptionView;
  nextRedemptionView = undefined;
  return view;
}
