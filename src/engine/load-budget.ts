export const MAX_VOLUME_BYTES = 64 * 1024 * 1024;

export const MAX_SELECTION_CHUNKS = 66;

/** Maximum retained history for datasets without forecast initializations. */
export const RECENT_TIME_SAMPLES = 66;

/** Ensembles keep every member so derived views stay exact; regions shrink to fit. */
export const MAX_ENSEMBLE_BYTES = 128 * 1024 * 1024;

/** Ensemble chunks hold all members but few cells, so more of them are needed per region. */
export const MAX_ENSEMBLE_CHUNKS = 200;

/** Upper bound on archive reads for one set of normals. */
export const MAX_BASELINE_CHUNKS = 600;
