/** Seconds as "0:24", for the wait after wrong passwords (NOTES-16 EC-1). */
export function clock(seconds: number): string {
  const whole = Math.max(0, Math.ceil(seconds))
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`
}
