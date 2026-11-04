import Taro from '@tarojs/taro';

let nextFilter: { keyword: string; category: string } | undefined;

export async function openRewards(keyword = '', category = '') {
  const filter = { keyword, category };
  nextFilter = filter;
  try {
    await Taro.switchTab({ url: '/pages/rewards/index' });
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
