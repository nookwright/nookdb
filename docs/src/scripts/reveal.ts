/**
 * Generic scroll-reveal. Every `.section-reveal` on the page glides in once it
 * enters the viewport — one shared mechanism with consistent timing (replaces
 * the old per-band observers). Sections that also carry `.reveal-stagger`
 * cascade their `.reveal-item` children instead of moving as one block; the
 * delays live in animations.css.
 *
 * Imported by every component that uses `.section-reveal`; Vite dedupes it to
 * a single instance per page, so the querySelectorAll runs once.
 */

const els = document.querySelectorAll<HTMLElement>('.section-reveal');
if (els.length) {
  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          entry.target.classList.add('is-visible');
          observer.unobserve(entry.target);
        }
      });
    },
    { threshold: 0.12 },
  );
  els.forEach((el) => observer.observe(el));
}

export {};
