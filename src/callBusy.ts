// A person can be in one call at a time: a call with one friend, or a conference with a group.
// Each side sets its flag while it is in a call and checks the other before starting or accepting one.
export const callBusy = { oneToOne: false, conference: false };
