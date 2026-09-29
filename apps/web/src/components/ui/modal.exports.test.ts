import { describe, expect, test } from 'bun:test';

// Characterization for the LazyModal deletion (KRTX-659): pins the module's
// surviving public surface so a later edit cannot drop an export the app
// imports. Passes before and after the deletion.
const SURVIVING_EXPORTS = [
  'Modal',
  'ModalBody',
  'ModalClose',
  'ModalContent',
  'ModalContentInner',
  'ModalDescription',
  'ModalFooter',
  'ModalHeader',
  'ModalOverlay',
  'ModalPortal',
  'ModalTitle',
  'ModalTrigger',
  'modalDismissesOnOutsideInteraction',
] as const;

const modal = await import('./modal');

describe('modal module surface', () => {
  test('every surviving named export is still defined', () => {
    for (const name of SURVIVING_EXPORTS) {
      expect(modal[name]).toBeDefined();
    }
  });
});
