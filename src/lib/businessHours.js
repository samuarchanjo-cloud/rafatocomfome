export const DAY_NAMES = ["Domingo", "Segunda", "Terça", "Quarta", "Quinta", "Sexta", "Sábado"];

function timeToMinutes(value) {
  if (!value) return null;
  const [hours, minutes] = String(value).split(":").map(Number);
  return Number.isFinite(hours) && Number.isFinite(minutes) ? hours * 60 + minutes : null;
}

export function shortTime(value) {
  if (!value) return "--:--";
  return String(value).slice(0, 5);
}

function zonedNow(date, timezone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const dayMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    day: dayMap[values.weekday],
    minutes: Number(values.hour) * 60 + Number(values.minute),
  };
}

function scheduleFor(hours, day) {
  return hours.find((item) => Number(item.day_of_week) === day);
}

function isWithinSchedule(schedule, minutes) {
  if (!schedule?.is_open) return false;
  const opening = timeToMinutes(schedule.opening_time);
  const closing = timeToMinutes(schedule.closing_time);
  if (opening === null || closing === null) return false;
  if (opening === closing) return true;
  if (closing > opening) return minutes >= opening && minutes < closing;
  return minutes >= opening || minutes < closing;
}

export function getBusinessStatus(hours, date = new Date(), timezone = "America/Sao_Paulo") {
  const safeHours = Array.isArray(hours) ? hours : [];
  const current = zonedNow(date, timezone);
  const today = scheduleFor(safeHours, current.day);
  const yesterday = scheduleFor(safeHours, (current.day + 6) % 7);
  const yesterdayClosing = timeToMinutes(yesterday?.closing_time);
  const yesterdayOpening = timeToMinutes(yesterday?.opening_time);
  const openFromYesterday =
    yesterday?.is_open &&
    yesterdayOpening !== null &&
    yesterdayClosing !== null &&
    yesterdayClosing < yesterdayOpening &&
    current.minutes < yesterdayClosing;
  const open = isWithinSchedule(today, current.minutes) || openFromYesterday;

  if (open) {
    const activeSchedule = openFromYesterday ? yesterday : today;
    return {
      open: true,
      label: "Aberto agora",
      detail: `Hoje até ${shortTime(activeSchedule.closing_time)}`,
      nextLabel: null,
    };
  }

  for (let offset = 0; offset <= 7; offset += 1) {
    const day = (current.day + offset) % 7;
    const schedule = scheduleFor(safeHours, day);
    if (!schedule?.is_open || !schedule.opening_time) continue;
    const opening = timeToMinutes(schedule.opening_time);
    if (offset === 0 && opening <= current.minutes) continue;
    const prefix = offset === 0 ? "Hoje" : offset === 1 ? "Amanhã" : DAY_NAMES[day];
    const nextLabel = `${prefix} às ${shortTime(schedule.opening_time)}`;
    return {
      open: false,
      label: "Fechado agora",
      detail: `Próxima abertura: ${nextLabel}`,
      nextLabel,
    };
  }

  return {
    open: false,
    label: "Fechado agora",
    detail: "Sem próximo horário configurado",
    nextLabel: "sem próximo horário configurado",
  };
}
