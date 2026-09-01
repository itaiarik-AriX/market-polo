// Site-wide constants that more than one component needs.
//
// BOOKING_URL lived in both Header.astro and Enquire.astro, with a comment in
// each admitting they were kept in sync by hand. The fleet overlay would have
// been a third copy, so it lives here now.
//
// Booking happens on Yescapa. Every link built from this opens in a new tab, so
// it must always be paired with rel="noopener noreferrer".
//
// One constant covers both call-to-actions AND both languages: the header pill
// and the van overlay's button each read it, and each already localises its own
// label (Book/Reservar, Check availability/Ver disponibilidad).
export const BOOKING_URL = 'https://www.yescapa.es/campers/119790';

// Where the mailto enquiries go — both the hire form in the van overlay and the
// build form in Enquire.astro. Also the address shown in the page footer.
export const EMAIL = 'Marketing@mountainvan.es';

// Social links shown in the footer. Placeholders until the accounts exist —
// '#' keeps the icons inert (no dead-tab navigation) rather than broken.
export const INSTAGRAM_URL = '#';
export const TIKTOK_URL = '#';
