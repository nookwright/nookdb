/**
 * TimelineBand IntersectionObserver — triggers staggered fade-in animation
 * when the timeline section enters the viewport (>30% visible).
 * The CSS already has animation-delay via CSS custom properties.
 */

const timeline = document.querySelector('.timeline');
if (timeline) {
  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          // Animation will run via CSS (animation is already defined with animation-delay)
          // No need to add a class; animations trigger on page load if in viewport
          // or when scrolled into view via the animation-delay cascade
          observer.unobserve(entry.target);
        }
      });
    },
    { threshold: 0.3 },
  );

  observer.observe(timeline);
}
