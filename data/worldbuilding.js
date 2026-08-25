/* 灵框 v3 · 世界观种子数据（与代码分离，供开源/复用）
 * 用户修改存 localStorage（lingkuang-timelines-v1），这里只做首次运行种子
 * 示例内容为通用演示数据，可随意替换。
 */
window.__SEED_TIMELINES__ = {
    'demo-world': {
      id: 'demo-world', name: '示例世界·白石大陆',
      absOffset: 0,               /* absolute-epoch offset (worldbuilding: fill in) */
      nodes: [
        { year: -800, type: 'event', title: '上古之门开启', desc: '传说中连通异界的门扉首次开启，秩序与混乱自此交织。',
          tag: '起源', people: [], places: ['上古之门'] },
        { year: -312, type: 'event', title: '裂隙时代', desc: '大陆裂变，诸城邦并起，史称裂隙时代。',
          tag: '时代', people: [], places: [] },
        { year: 0, type: 'event', title: '纪元元年·王城奠基', desc: '第一王城落成，白石纪年由此开始。',
          tag: '建制', people: ['初代王'], places: ['王城'] },
        { year: 426, type: 'plot', title: '旅人艾诺出生', desc: '后来被记载为「雾中旅人」的艾诺出生。',
          tag: '人物', people: ['艾诺'], places: [] },
        { year: 612, type: 'event', title: '黑潮之战', desc: '来自海渊的黑潮吞没沿岸三城，历时九年方退。',
          tag: '大战', people: [], places: ['黑潮海岸'] },
        { year: 980, type: 'event', title: '三界分立', desc: '天、地、渊三界正式分立，通界之法失传。',
          tag: '时代', people: [], places: [] },
        { year: 1450, type: 'event', title: '静默期', desc: '近两百年的「静默期」，鲜有重大事件被记录。',
          tag: '时代', people: [], places: [] },
        { year: 1632, type: 'plot', title: '星语者出生', desc: '',
          tag: '人物', people: ['星语者'], places: [] },
        { year: 1832, type: 'event', title: '现在', desc: '示例世界·白石大陆，当前纪年。',
          tag: '当下', people: [], places: [] },
        /* ── 公历测试节点（带 year/month/day，方便验证闰年/大小月）── */
        { year: 1900, month: 2, day: 28, type: 'event', title: '公历·1900平年2月28', desc: '1900 非闰（百倍需400整除），2月只有28天。', tag: '测试', people: [], places: [] },
        { year: 1999, month: 12, day: 31, type: 'event', title: '公历·1999年12月31', desc: '平年年末，12月有31天。', tag: '测试', people: [], places: [] },
        { year: 2000, month: 2, day: 29, type: 'event', title: '公历·2000闰年2月29', desc: '2000 是闰年（400整除），2月29天。', tag: '测试', people: [], places: [] },
        { year: 2023, month: 2, day: 28, type: 'event', title: '公历·2023平年2月28', desc: '2023 平年，2月28天。', tag: '测试', people: [], places: [] },
        { year: 2024, month: 2, day: 29, type: 'event', title: '公历·2024闰年2月29', desc: '2024 闰年（4整除），2月29天。', tag: '测试', people: [], places: [] },
        { year: 2024, month: 3, day: 1, type: 'event', title: '公历·2024年3月1', desc: '闰年后3月1，验证跨月边界。', tag: '测试', people: [], places: [] },
        { year: 2024, month: 4, day: 30, type: 'event', title: '公历·2024年4月30', desc: '4月30天（小月）。', tag: '测试', people: [], places: [] },
        { year: 2024, month: 7, day: 15, type: 'plot', title: '公历·2024年7月15', desc: '大月中的日子，测节点定位。', tag: '测试', people: [], places: [] }
      ]
    },
    'demo-echo': {
      id: 'demo-echo', name: '示例世界·回响之海',
      absOffset: -221,            /* 2053 (this world) = 1832 (world 1) — same "now" */
      nodes: [
        { year: 2053, type: 'event', title: '现在', desc: '示例世界·回响之海，当前纪年。',
          tag: '当下', people: [], places: [] }
      ]
    },
    'demo-cycle': {
      id: 'demo-cycle', name: '示例世界·潮汐轮回',
      absOffset: 672,             /* cycle 0 = world-1 year 672 (first invasion) */
      loop: {
        interval: 592,            /* years per cycle */
        count: 3,                 /* how many cycles are shown */
        styles: [                 /* each style is one possible cycle variant */
          {
            id: 's0', name: '标准轮回',
            nodes: [
              { year: 0, type: 'event', title: '周期起始·潮汐初涨', desc: '潮汐轮回的起始，海面开始异动。',
                tag: '周期', people: [], places: ['潮汐之眼'] },
              { year: 100, type: 'event', title: '暗流涌动', desc: '深海暗流积蓄力量。',
                tag: '周期', people: [], places: [] },
              { year: 200, type: 'event', title: '回声共振', desc: '海岸的钟楼同时响起无人敲响的钟声。',
                tag: '联动', people: [], places: [] },
              { year: 300, type: 'event', title: '潮间带异变', desc: '潮间带的生物开始反季节繁衍。',
                tag: '周期', people: [], places: [] },
              { year: 400, type: 'event', title: '涨潮加速', desc: '潮水上涨速度远超往常。',
                tag: '周期', people: [], places: [] },
              { year: 500, type: 'event', title: '大潮前兆', desc: '百年一遇的大潮即将到来。',
                tag: '周期', people: [], places: [] },
              { year: 592, type: 'event', title: '周期重启·大潮吞岸', desc: '592 年大潮吞没旧岸线，轮回重启。',
                tag: '周期', people: [], places: ['潮汐之眼'] }
            ]
          }
        ]
      },
      nodes: [
        { year: 568, type: 'event', title: '现在', desc: '示例世界·潮汐轮回，当前周期年（对应世界一 1832）。',
          tag: '当下', people: [], places: [] }
      ]
    },
    'newline': { id: 'newline', name: '新世界线', absOffset: 0, nodes: [] }
  };
