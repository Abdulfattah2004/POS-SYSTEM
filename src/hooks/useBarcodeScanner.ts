import { useEffect, useCallback, useRef } from 'react';

/**
 * Detects rapid keyboard input from barcode scanners.
 * Scanners type characters very fast and end with Enter.
 */
export function useBarcodeScanner(onScan: (barcode: string) => void, enabled = true) {
  const buffer = useRef('');
  const lastKeyTime = useRef(0);
  const timeout = useRef<ReturnType<typeof setTimeout>>();

  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (!enabled) return;
    // Ignore if user is typing in an input/textarea (unless it's the barcode input)
    const target = e.target as HTMLElement;
    const isInput = target.tagName === 'INPUT' || target.tagName === 'TEXTAREA';
    const isBarcodeInput = target.getAttribute('data-barcode-input') === 'true';
    
    // Focused fields own their Enter event. Never process the same scan twice.
    if (isInput || target.isContentEditable || e.defaultPrevented) {
      buffer.current = '';
      return;
    }

    const now = Date.now();
    const timeDiff = now - lastKeyTime.current;

    if (e.key === 'Enter') {
      if (buffer.current.length >= 3) {
        e.preventDefault();
        onScan(buffer.current.trim());
      }
      buffer.current = '';
      if (timeout.current) clearTimeout(timeout.current);
      return;
    }

    // Only single printable characters
    if (e.key.length === 1) {
      if (timeDiff > 100) {
        // Too slow — probably manual typing, reset buffer
        buffer.current = '';
      }
      buffer.current += e.key;
      lastKeyTime.current = now;

      // Auto-clear buffer after inactivity
      if (timeout.current) clearTimeout(timeout.current);
      timeout.current = setTimeout(() => {
        buffer.current = '';
      }, 200);
    }
  }, [onScan, enabled]);

  useEffect(() => {
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      if (timeout.current) clearTimeout(timeout.current);
    };
  }, [handleKeyDown]);
}
