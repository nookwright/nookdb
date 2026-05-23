// Threshold lowered to 0.15: sticky cards are 100vh tall so they never reach
// 50% intersection against a 100vh viewport. 15% fires reliably on enter.
const observer = new IntersectionObserver(
  (entries) => {
    entries.forEach((entry) => {
      if (entry.isIntersecting && entry.intersectionRatio >= 0.15) {
        entry.target.classList.add('is-active');
      }
    });
  },
  { threshold: [0.15] }
);

document.querySelectorAll('.story-card').forEach((card) => observer.observe(card));

export {};
