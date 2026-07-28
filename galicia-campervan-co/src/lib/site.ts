// Site-wide constants that more than one component needs.
//
// BOOKING_URL lived in both Header.astro and Enquire.astro, with a comment in
// each admitting they were kept in sync by hand. The fleet overlay would have
// been a third copy, so it lives here now.
//
// Booking happens on a third-party site; this is a placeholder until the real
// link arrives. Every link built from it opens in a new tab, so it must always
// be paired with rel="noopener noreferrer".
export const BOOKING_URL = '#';

// Where the mailto enquiries go.
export const EMAIL = 'itaiarik@gmail.com';
