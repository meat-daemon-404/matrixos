// 本文件由 tools/derive-career-calibration.mjs 自动生成，请勿手改。
// 重新生成：node tools/derive-career-calibration.mjs
// 校验一致：node tools/derive-career-calibration.mjs --check
//
// 数据来源：学职平台 xz.chsi.com.cn（教育部学生服务与素质发展中心）
// 采集快照：2026-10-20T12:22:11.728Z（statYear 2025）
// 口径：1778 条专业目录中筛出 1036 条本科层次专业；
//       722 条职业人物案例仅作行业参照，不参与校准乘法。

export const CAREER_CALIBRATION = {
  "meta": {
    "source": "学职平台 xz.chsi.com.cn（教育部学生服务与素质发展中心）",
    "homeUrl": "https://xz.chsi.com.cn/",
    "statYear": 2025,
    "collectedAt": "2026-10-20T12:22:11.728Z",
    "specialityTotal": 1778,
    "undergradTotal": 1036,
    "caseTotal": 722,
    "caseCollected": 722,
    "notice": "学职平台不提供薪资与升学率字段。本表只把「就业满意度 / 评价票数 / 开设院校数」用于相对校准，不构成对期望收益绝对量级的真实测量；期望收益的万元量级仍来自 MatrixOS 模型假设。"
  },
  "global": {
    "specialityCount": 1036,
    "ratedCount": 534,
    "satisfaction": 3.86,
    "votes": 4177340,
    "avgOfferCount": 62.3,
    "realityIndex": 0.739
  },
  "paths": [
    {
      "id": "p1",
      "name": "推免直博",
      "scopes": [
        "工学/材料类",
        "工学/电子信息类",
        "工学/机械类",
        "工学/计算机类",
        "工学/电气类",
        "工学/自动化类",
        "工学/力学类",
        "工学/仪器类",
        "理学/化学类",
        "理学/物理学类",
        "理学/数学类",
        "理学/生物科学类"
      ],
      "caseIndustries": [
        "教育/行政"
      ],
      "caseCount": 88,
      "caseShare": 0.122,
      "specialityCount": 130,
      "ratedCount": 87,
      "satisfaction": 3.9,
      "votes": 1111245,
      "avgOfferCount": 132.1,
      "avgScore": 2.81,
      "realityIndex": 0.754,
      "calibration": 1.02,
      "modelGain": 85,
      "expectedGain": 87,
      "risk": "medium",
      "modelTrajectory": [
        2,
        4,
        6,
        8,
        15
      ],
      "trajectory": [
        2,
        4,
        6,
        8,
        15
      ],
      "modelProbabilities": {
        "success": 0.62,
        "neutral": 0.28,
        "fail": 0.1
      },
      "probabilities": {
        "success": 0.52,
        "neutral": 0.35,
        "fail": 0.13
      },
      "topSpeciality": {
        "specId": "woqt114tyt2flxjh",
        "code": "080901",
        "name": "计算机科学与技术",
        "faculty": "工学",
        "category": "计算机类",
        "evlCount": 144133,
        "evlScore": 4.1,
        "satisfactionRank": 4,
        "satisfactionCount": 135973,
        "url": "https://xz.chsi.com.cn/speciality/detail.action?specId=woqt114tyt2flxjh"
      }
    },
    {
      "id": "p2",
      "name": "头部光企研发",
      "scopes": [
        "工学/电子信息类",
        "工学/材料类",
        "工学/仪器类",
        "电子与信息/电子信息类",
        "电子与信息/通信类",
        "电子与信息/集成电路类",
        "装备制造/自动化类",
        "能源动力与材料/新能源发电工程类",
        "理学/物理学类"
      ],
      "caseIndustries": [
        "互联网/通信"
      ],
      "caseCount": 114,
      "caseShare": 0.158,
      "specialityCount": 68,
      "ratedCount": 42,
      "satisfaction": 3.8,
      "votes": 305966,
      "avgOfferCount": 82.8,
      "avgScore": 2.61,
      "realityIndex": 0.695,
      "calibration": 0.94,
      "modelGain": 120,
      "expectedGain": 113,
      "risk": "low",
      "modelTrajectory": [
        18,
        22,
        25,
        27,
        28
      ],
      "trajectory": [
        17,
        21,
        23,
        25,
        26
      ],
      "modelProbabilities": {
        "success": 0.78,
        "neutral": 0.18,
        "fail": 0.04
      },
      "probabilities": {
        "success": 0.59,
        "neutral": 0.3,
        "fail": 0.11
      },
      "topSpeciality": {
        "specId": "x34jt0lncniica56",
        "code": "080701",
        "name": "电子信息工程",
        "faculty": "工学",
        "category": "电子信息类",
        "evlCount": 73673,
        "evlScore": 4.1,
        "satisfactionRank": 3.9,
        "satisfactionCount": 69517,
        "url": "https://xz.chsi.com.cn/speciality/detail.action?specId=x34jt0lncniica56"
      }
    },
    {
      "id": "p3",
      "name": "选调考公",
      "scopes": [
        "法学/法学类",
        "法学/政治学类",
        "法学/社会学类",
        "法学/马克思主义理论类",
        "公共管理与服务/公共管理类",
        "公共管理与服务/公共事业类",
        "公安与司法/法律实务类",
        "公安与司法/公安管理类",
        "管理学/公共管理类"
      ],
      "caseIndustries": [
        "公务员/监察法律/社会服务"
      ],
      "caseCount": 69,
      "caseShare": 0.096,
      "specialityCount": 58,
      "ratedCount": 26,
      "satisfaction": 3.66,
      "votes": 239397,
      "avgOfferCount": 53.9,
      "avgScore": 1.84,
      "realityIndex": 0.66,
      "calibration": 0.893,
      "modelGain": 70,
      "expectedGain": 63,
      "risk": "low",
      "modelTrajectory": [
        10,
        12,
        14,
        16,
        18
      ],
      "trajectory": [
        9,
        11,
        13,
        14,
        16
      ],
      "modelProbabilities": {
        "success": 0.55,
        "neutral": 0.35,
        "fail": 0.1
      },
      "probabilities": {
        "success": 0.37,
        "neutral": 0.35,
        "fail": 0.28
      },
      "topSpeciality": {
        "specId": "e38wliz5hwewp9s3",
        "code": "030101",
        "name": "法学",
        "faculty": "法学",
        "category": "法学类",
        "evlCount": 117919,
        "evlScore": 4.3,
        "satisfactionRank": 3.8,
        "satisfactionCount": 111852,
        "url": "https://xz.chsi.com.cn/speciality/detail.action?specId=e38wliz5hwewp9s3"
      }
    }
  ]
} as const;

export type CareerCalibration = typeof CAREER_CALIBRATION;
export type CareerPathCalibration = CareerCalibration['paths'][number];
