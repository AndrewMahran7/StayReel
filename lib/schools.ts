// lib/schools.ts
// Central list of schools for the attribution picker.
// Add new schools here — the modal and settings screen read from this array.

export interface School {
  id: string;       // stable key for DB storage
  label: string;    // display name
}

/**
 * Ordered list shown in the school picker modal.
 * "other" is a special sentinel — the UI can show a text input for it.
 */
export const SCHOOLS: School[] = [
  { id: 'cal_poly_pomona',   label: 'Cal Poly Pomona' },
  { id: 'uc_santa_cruz',     label: 'UC Santa Cruz' },
  { id: 'san_diego_state',   label: 'San Diego State' },
  { id: 'ucla',              label: 'UCLA' },
  { id: 'usc',               label: 'USC' },
  { id: 'uc_berkeley',       label: 'UC Berkeley' },
  { id: 'other',             label: 'Other' },
];

/** Lookup display label from a stored school id. */
export function schoolLabel(id: string | null | undefined): string {
  if (!id) return 'Not set';
  const found = SCHOOLS.find((s) => s.id === id);
  return found?.label ?? id;   // fallback to raw id if list changes
}
