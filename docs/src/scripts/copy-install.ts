// copy-install.ts
//
// Wires every [data-copy-install] button to copy its [data-copy-text]
// content to the clipboard, then briefly flips [data-copy-hint] to a
// success state ("copied") for ~1.4 seconds.

function init() {
  const buttons = document.querySelectorAll<HTMLButtonElement>(
    '[data-copy-install]'
  );

  buttons.forEach((btn) => {
    btn.addEventListener('click', async () => {
      const textEl = btn.querySelector<HTMLElement>('[data-copy-text]');
      const hintEl = btn.querySelector<HTMLElement>('[data-copy-hint]');
      if (!textEl || !hintEl) return;

      const text = textEl.textContent?.trim() ?? '';
      try {
        await navigator.clipboard.writeText(text);
        hintEl.textContent = 'copied';
        hintEl.dataset.copied = '1';
        window.setTimeout(() => {
          hintEl.textContent = 'copy';
          delete hintEl.dataset.copied;
        }, 1400);
      } catch {
        // Clipboard API blocked (e.g., insecure context). Fall back
        // to legacy execCommand or just no-op silently.
        hintEl.textContent = 'select & copy';
      }
    });
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init, { once: true });
} else {
  init();
}

export {};
