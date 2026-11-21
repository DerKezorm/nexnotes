/** The history docks onto the frame (`extensions.ts`): the page `/notes/<id>/history`, opened from the note's menu. */
import { FEATURE_ROUTES } from '../extensions'
import { HistoryPage } from './HistoryPage'

FEATURE_ROUTES.push({ path: 'notes/:noteId/history', element: <HistoryPage /> })
