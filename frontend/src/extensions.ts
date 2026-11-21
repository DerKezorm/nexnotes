/**
 * Where the note features dock onto the frame. The frame shows no notes; a feature adds itself here once, from its own
 * module (imported in `main.tsx` before the first render), and the frame draws it in its place:
 *
 * - `FEATURE_ROUTES`: pages inside the signed-in shell, beside the start area (`/` stays `NotesHome` until a feature
 *   puts its own element at `''`, the index). A route marked `list` is a list of the notes' workspace: it shows in the
 *   middle while the notes and their tabs stay beside it (`LIST_LAYOUT`, NOTES-8 AC-9); every other route takes the
 *   whole area (settings, trash, history, attachments).
 * - `SIDEBAR_SECTIONS`: entries of the sidebar between the name and the account (new note, search, inbox, folders,
 *   smart folders, tags, trash), in the order of the drawing "Seitenleiste".
 * - `CONNECTION_SECTIONS`: cards of Settings, Connections (devices, nextasks, MCP keys, vault password).
 * - `ACCOUNT_SECTIONS`: cards at the end of "Mein Konto" (the read links of the member, NOTES-13 AC-13).
 * - `SHELL_BANNERS`: bars over every page of the signed-in shell (the full storage of the attachments, NOTES-10).
 * - `SHELL_PARTS`: things over every page of the signed-in app, beside the page itself (the notices of exports).
 */
import type { ReactNode } from 'react'

export type FeatureRoute = { path: string; element: ReactNode; list?: boolean }
export type Section = { key: string; render: () => ReactNode }

export const FEATURE_ROUTES: FeatureRoute[] = []
/** The workspace the `list` routes show in (set by the notes); without it they are pages of their own. */
export const LIST_LAYOUT: { element: ReactNode | null } = { element: null }
export const SIDEBAR_SECTIONS: Section[] = []
export const CONNECTION_SECTIONS: Section[] = []
export const ACCOUNT_SECTIONS: Section[] = []
export const SHELL_BANNERS: Section[] = []
export const SHELL_PARTS: Section[] = []
