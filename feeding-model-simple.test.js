const assert = require('node:assert/strict')
const {
  MODEL_VERSION,
  createFeedingBatch,
  restoreFeedingBatch,
  getDailyCapacity,
  getEvenlySkippedMeals,
  getStandardWeight,
} = require('./feeding-model-simple')

function round(value, digits = 2) {
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

function assertMilkIdentity(result) {
  const r = result.recommendation
  assert.equal(r.perPigMilkG, round(r.perFeedPerPigMilkG * r.feedTimes))
  assert.equal(r.milkReductionG, round(r.perFeedPerPigMilkG * r.removedMeals))
  assert.equal(
    r.perPigMilkWithoutDiarrheaG,
    round(r.perFeedPerPigMilkG * r.plannedFeedTimesWithoutDiarrhea),
  )
}

// 年龄、体重和基础公式
assert.equal(getStandardWeight(7), 3)
assert.equal(getStandardWeight(22), 6)
assert.equal(getStandardWeight(30), 7.6)
assert.equal(getDailyCapacity(3), 153)
assert.throws(() => getStandardWeight(2), /3～30/)
assert.throws(() => createFeedingBatch(31), /3～30/)

// 均匀减餐和最少 2 餐保护
assert.deepEqual(getEvenlySkippedMeals(12, 3), [3, 6, 9])
assert.deepEqual(getEvenlySkippedMeals(8, 3), [2, 4, 6])
assert.deepEqual(getEvenlySkippedMeals(4, 3), [1, 3])
assert.deepEqual(getEvenlySkippedMeals(2, 3), [])

// 基础兼容路径
const batch = createFeedingBatch(7)
const day1 = batch.recordDay('无', '无')
assert.equal(day1.dayAge, 7)
assert.equal(day1.recommendation.feedTimes, 12)
assert.equal(day1.recommendation.perPigMilkG, 45.96)
assertMilkIdentity(day1)

const day2 = batch.recordDay('中', '无')
assert.equal(day2.dayAge, 8)
assert.equal(day2.recommendation.feedTimes, 12)
assertMilkIdentity(day2)

const day3 = batch.recordDay('高', '轻度')
assert.equal(day3.recommendation.plannedFeedTimesWithoutDiarrhea, 12)
assert.equal(day3.recommendation.feedTimes, 11)
assert.equal(day3.recommendation.requestedRemovedMeals, 1)
assert.equal(day3.recommendation.removedMeals, 1)
assertMilkIdentity(day3)

const day4 = batch.recordDay('高', '严重')
assert.equal(day4.recommendation.plannedFeedTimesWithoutDiarrhea, 12)
assert.equal(day4.recommendation.feedTimes, 9)
assert.equal(day4.recommendation.requestedRemovedMeals, 3)
assert.equal(day4.recommendation.removedMeals, 3)
assert.deepEqual(day4.recommendation.skippedMealNumbers, [3, 6, 9])
assert.match(day4.warnings.join(''), /联系兽医/)
assertMilkIdentity(day4)

// 返回对象被调用方修改时，不应污染内部历史。
day4.recommendation.feedTimes = 99
assert.equal(batch.getState().history[3].recommendation.feedTimes, 9)
assert.equal(batch.getState().feedTimes, batch.getState().controlFeedTimes)

// 核心回归：同一等级连续输入时不得再回弹。
const expectedSequences = {
  low: [11, 11, 11, 10, 10, 10, 9, 9, 9, 8],
  medium: [10, 10, 9, 9, 8, 8, 7, 7, 6, 6],
  high: [8, 7, 6, 5, 5, 4, 4, 4, 4, 4],
}
for (const [level, expected] of Object.entries(expectedSequences)) {
  const sequenceBatch = createFeedingBatch(21)
  const actual = []
  while (!sequenceBatch.isComplete()) {
    const result = sequenceBatch.recordDay(level, 'none')
    actual.push(result.recommendation.plannedFeedTimesWithoutDiarrhea)
    assertMilkIdentity(result)
  }
  assert.deepEqual(actual, expected)
}

// 等级变差才恢复；同等级后续仍可继续递减。
const worseningBatch = createFeedingBatch(21)
assert.equal(worseningBatch.recordDay('high', 'none').recommendation.feedTimes, 8)
assert.equal(worseningBatch.recordDay('high', 'none').recommendation.feedTimes, 7)
const worsened = worseningBatch.recordDay('medium', 'none')
assert.equal(worsened.recommendation.feedTimes, 10)
assert.match(worsened.recommendation.action, /采食等级下降/)
assert.equal(worseningBatch.recordDay('medium', 'none').recommendation.feedTimes, 10)
assert.equal(worseningBatch.recordDay('medium', 'none').recommendation.feedTimes, 9)

// 腹泻只改变当天执行餐次，不覆盖正常控奶状态。
const diarrheaBatch = createFeedingBatch(21)
const mild = diarrheaBatch.recordDay('high', 'mild')
assert.equal(mild.recommendation.plannedFeedTimesWithoutDiarrhea, 8)
assert.equal(mild.recommendation.feedTimes, 7)
assert.equal(diarrheaBatch.getState().controlFeedTimes, 8)
const severe = diarrheaBatch.recordDay('high', 'severe')
assert.equal(severe.recommendation.plannedFeedTimesWithoutDiarrhea, 8)
assert.equal(severe.recommendation.feedTimes, 5)
assert.deepEqual(severe.recommendation.skippedMealNumbers, [2, 4, 6])
assert.equal(diarrheaBatch.getState().controlFeedTimes, 8)
assert.equal(diarrheaBatch.recordDay('high', 'none').recommendation.feedTimes, 7)

// 低餐次时以每天至少 2 餐为优先，并如实报告实际取消数。
const floorSource = createFeedingBatch(21)
floorSource.recordDay('high', 'none')
const floorSnapshot = floorSource.getState()
floorSnapshot.controlFeedTimes = 4
floorSnapshot.feedTimes = 4
const floorResult = restoreFeedingBatch(floorSnapshot).recordDay('high', 'severe')
assert.equal(floorResult.recommendation.requestedRemovedMeals, 3)
assert.equal(floorResult.recommendation.removedMeals, 2)
assert.equal(floorResult.recommendation.feedTimes, 2)
assert.match(floorResult.recommendation.action, /取消 2 餐/)
assert.match(floorResult.warnings.join(''), /实际取消 2 餐/)
assertMilkIdentity(floorResult)

// 状态恢复后，下一日结果应与不中断运行完全相同。
const continuous = createFeedingBatch(21)
continuous.recordDay('high', 'none')
continuous.recordDay('medium', 'mild')
const snapshot = continuous.getState()
assert.equal(snapshot.version, MODEL_VERSION)
const restored = restoreFeedingBatch(JSON.parse(JSON.stringify(snapshot)))
assert.deepEqual(
  restored.recordDay('medium', 'none'),
  continuous.recordDay('medium', 'none'),
)
assert.throws(
  () => restoreFeedingBatch({ ...snapshot, version: 'old-version' }),
  /版本无效/,
)
assert.throws(
  () => restoreFeedingBatch({ ...snapshot, history: [] }),
  /历史长度/,
)

// 30 日龄后批次结束，不允许无限外推。
const lastAgeBatch = createFeedingBatch(30)
assert.equal(lastAgeBatch.isComplete(), false)
assert.equal(lastAgeBatch.recordDay('无', '无').dayAge, 30)
assert.equal(lastAgeBatch.isComplete(), true)
assert.throws(() => lastAgeBatch.recordDay('无', '无'), /批次已结束/)

// 输入词表保持兼容。
assert.throws(() => createFeedingBatch(7).recordDay('很好', '无'), /教槽料采食等级无效/)
assert.throws(() => createFeedingBatch(7).recordDay('高', '中度'), /腹泻情况无效/)

console.log('feeding-model-simple: all tests passed')
