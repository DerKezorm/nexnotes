/**
 * The two pages of MCP access (module mcp) with nexnotes' client and words: "Programm verbinden" at `/oauth/authorize`
 * and one request at `/mcp/requests/<id>`.
 */
import { useTranslation } from 'react-i18next'
import { useLocation, useParams } from 'react-router-dom'

import { ConsentPage, RequestPage } from '../vendor/nexmcp'
import { leave, mcpRequest, useMcpWords } from './words'

export function Consent() {
  const { t, i18n } = useTranslation()
  const { search } = useLocation()
  return (
    <div className="mx-auto w-full max-w-md p-6">
      <ConsentPage
        request={mcpRequest}
        search={search}
        areaWord={t('tokens.dialog.folders')}
        words={useMcpWords()}
        language={i18n.language}
        navigate={(address) => leave.to(address)}
      />
    </div>
  )
}

export function Request() {
  const { i18n } = useTranslation()
  const { id = '' } = useParams()
  return (
    <div className="mx-auto w-full max-w-xl p-6">
      <RequestPage request={mcpRequest} id={id} words={useMcpWords()} language={i18n.language} />
    </div>
  )
}
