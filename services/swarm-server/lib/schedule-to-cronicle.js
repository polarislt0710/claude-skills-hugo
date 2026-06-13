function dedupSort(arr) {
  return Array.from(new Set(arr.map((n) => Number(n)).filter((n) => Number.isFinite(n)))).sort((a, b) => a - b);
}

function toCronicleTiming(schedule) {
  if (!schedule || !schedule.mode) throw new Error('schedule.mode required');

  const minutes = dedupSort(schedule.minutes || [0]);
  const hours = dedupSort(schedule.hours || []);
  if (hours.length === 0) throw new Error('hours required (at least one)');

  const out = { minutes, hours };

  switch (schedule.mode) {
    case 'daily':
      break;
    case 'weekly': {
      const wd = dedupSort(schedule.weekdays || []);
      if (wd.length === 0) throw new Error('weekly mode requires weekdays[] (0=Sun..6=Sat)');
      out.weekdays = wd;
      break;
    }
    case 'monthly': {
      const d = dedupSort(schedule.days || []);
      if (d.length === 0) throw new Error('monthly mode requires days[] (1..31)');
      out.days = d;
      break;
    }
    case 'yearly': {
      const d = dedupSort(schedule.days || []);
      const m = dedupSort(schedule.months || []);
      if (d.length === 0 || m.length === 0) throw new Error('yearly mode requires days[] and months[]');
      out.days = d;
      out.months = m;
      break;
    }
    default:
      throw new Error(`unknown schedule mode: ${schedule.mode}`);
  }
  return out;
}

function toCronPreview(timing) {
  const fmt = (a, max) => (!a || a.length === 0 || a.length === max ? '*' : a.join(','));
  return [
    fmt(timing.minutes, 60),
    fmt(timing.hours, 24),
    fmt(timing.days, 31),
    fmt(timing.months, 12),
    fmt(timing.weekdays, 7),
  ].join(' ');
}

module.exports = { toCronicleTiming, toCronPreview };
