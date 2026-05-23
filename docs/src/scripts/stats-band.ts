/**
 * StatsBand count-up. When the band scrolls into view, each cell's number
 * animates from 0 to its final value over ~1.2s with ease-out, staggered
 * left-to-right. Prefix/suffix (e.g. '~', '%', 'ms') are preserved so
 * '~7ms' counts as '~0ms → ~7ms' and '100%' counts as '0% → 100%'.
 *
 * Honest about static values: a target of 0 doesn't animate (no fake
 * count-up to and from itself). Honest about reduced motion: skip the
 * count entirely and paint the final value.
 */

const COUNT_DURATION = 1200; // ms — long enough that 0→100 feels deliberate
const STAGGER_PER_CELL = 120; // ms — cells light up one after the other

// ease-out cubic — starts fast, settles smoothly to the final number
const easeOutCubic = (t: number): number => 1 - Math.pow(1 - t, 3);

interface Target {
  prefix: string;
  num: number;
  suffix: string;
  /** 0 when the original value was integer; 1 for one decimal place, etc. */
  decimals: number;
}

function parseValue(raw: string): Target | null {
  // [non-digit prefix] [number] [trailing suffix]
  // e.g. '~7ms' → prefix='~', num=7, suffix='ms'
  // e.g. '100%' → prefix='',  num=100, suffix='%'
  // e.g. '<1.5ms' → prefix='<', num=1.5, suffix='ms'
  const m = raw.match(/^([^\d\-.]*)(-?\d+(?:\.\d+)?)(.*)$/);
  if (!m) return null;
  const numStr = m[2] ?? '0';
  const fractional = numStr.split('.')[1];
  return {
    prefix: m[1] ?? '',
    num: parseFloat(numStr),
    suffix: m[3] ?? '',
    decimals: fractional ? fractional.length : 0,
  };
}

function format(target: Target, value: number): string {
  return target.prefix + value.toFixed(target.decimals) + target.suffix;
}

function animateCell(el: HTMLElement, target: Target, delayMs: number): void {
  // Static-zero targets ('0 IPC boilerplate') don't get a fake animation —
  // they would just sit at 0 for 1.2s. Paint immediately.
  if (target.num === 0) {
    el.textContent = format(target, 0);
    return;
  }

  const startAt = performance.now() + delayMs;
  const endAt = startAt + COUNT_DURATION;

  function frame(now: number): void {
    if (now < startAt) {
      // hold at zero through the stagger delay
      el.textContent = format(target, 0);
      requestAnimationFrame(frame);
      return;
    }
    const t = Math.min(1, (now - startAt) / COUNT_DURATION);
    const v = target.num * easeOutCubic(t);
    el.textContent = format(target, v);
    if (now < endAt) {
      requestAnimationFrame(frame);
    } else {
      // snap to exact final value — eliminates any floating-point drift
      // that the eased path might leave in the last frame.
      el.textContent = format(target, target.num);
    }
  }

  requestAnimationFrame(frame);
}

const band = document.querySelector<HTMLElement>('.stats-band');
if (band) {
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const cells = band.querySelectorAll<HTMLElement>('.stat-cell__number');

  // Capture targets up front + reset visible text to the zero-state so the
  // user never glimpses the final number before the animation fires.
  const items: Array<{ el: HTMLElement; target: Target | null }> = [];
  cells.forEach((el) => {
    const raw = (el.dataset.value ?? el.textContent ?? '').trim();
    const target = parseValue(raw);
    if (target && !reducedMotion) {
      el.textContent = format(target, 0);
    }
    items.push({ el, target });
  });

  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        band.classList.add('is-active'); // keep CSS fade-in behaviour
        items.forEach(({ el, target }, i) => {
          if (!target) return;
          if (reducedMotion) {
            el.textContent = format(target, target.num);
          } else {
            animateCell(el, target, i * STAGGER_PER_CELL);
          }
        });
        observer.unobserve(entry.target);
      });
    },
    { threshold: 0.3 },
  );

  observer.observe(band);
}
