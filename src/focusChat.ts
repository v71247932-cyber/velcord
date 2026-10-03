import { isMobileDevice } from './notify';

export const FOCUS_CHAT = 'velcord:focus-chat';

/** Puts the cursor in the message box of the chat that was just opened (not on phones: it would pop up the keyboard). */
export function requestChatFocus() {
    if (isMobileDevice()) return;
    // a moment later, so a chat that is being opened has been drawn first
    setTimeout(() => window.dispatchEvent(new Event(FOCUS_CHAT)), 60);
}
