import { unitSeconds } from './coordinates';

/** Calendar years are labels, not durations that can be converted to forecast hours. */
export const isWinterTime = (units: string) => units === 'winter year';

/** The member-split cube stacks members by signed rank instead of time. */
export const isMemberRank = (units: string) => units.startsWith('member rank');

/** Empty rank steps on each side of the average plane in a member-split cube. */
const memberGap = (units: string) => Number(units.match(/gap=(\d+)/)?.[1] ?? 0);

export const timeValue = (value: number, units: string) =>
  isWinterTime(units) || isMemberRank(units) ? value : (value * unitSeconds(units)) / 3600;

export const timeLabel = (value: number, units: string) =>
  isWinterTime(units)
    ? `Winter ${value}`
    : isMemberRank(units)
      ? Math.abs(value) < memberGap(units)
        ? 'average'
        : value < 0
          ? `${-value - memberGap(units)} below`
          : `${value - memberGap(units)} above`
      : `+${timeValue(value, units)} h`;
