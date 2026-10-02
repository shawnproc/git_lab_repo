import { useState } from 'react'
import { api, type Learn as LearnData } from '../api'
import { Card, ErrorText, PageHeader } from '../components/ui'
import { useApi } from '../useApi'

export function LearnView({ data }: { data: LearnData }) {
  const [q, setQ] = useState('')
  const needle = q.trim().toLowerCase()
  const terms = data.glossary.filter(
    (g) => !needle || `${g.term} ${g.definition} ${g.why_it_matters}`.toLowerCase().includes(needle),
  )
  const topics = [...new Set(data.links.map((l) => l.topic))]
  return (
    <div className="space-y-6">
      <Card title="Word list (glossary)">
        <input className="input mb-4" placeholder="Search a word, like VIX or ETF" value={q}
          onChange={(e) => { setQ(e.target.value) }} aria-label="Search the word list" />
        {terms.length === 0 && <p className="muted">No match. Try a shorter word.</p>}
        <dl className="grid gap-4 md:grid-cols-2">
          {terms.map((g) => (
            <div key={g.term} className="rounded-xl border border-[var(--line)] p-4">
              <dt className="text-lg font-bold">{g.term}</dt>
              <dd className="mt-1">{g.definition}</dd>
              <dd className="mt-2 text-sm"><b>Why it matters to you:</b> {g.why_it_matters}</dd>
              {g.example && <dd className="muted mt-2 text-sm"><b>Example:</b> {g.example}</dd>}
            </div>
          ))}
        </dl>
      </Card>
      <Card title="Common questions">
        <div className="space-y-2">
          {data.faq.map((f) => (
            <details key={f.q} className="rounded-xl border border-[var(--line)] px-4 py-3">
              <summary className="cursor-pointer font-semibold">{f.q}</summary>
              <p className="mt-2 leading-relaxed">{f.a}</p>
            </details>
          ))}
        </div>
      </Card>
      <Card title="Trusted places to learn more (all free)">
        {data.pending_links > 0 && (
          <p className="mb-3 rounded-lg border border-[var(--line)] p-3 text-sm">
            {data.pending_links} link(s) are waiting to be checked. Links only appear here after the app confirms they
            open. In PowerShell, run <code>.\tasks.ps1 verify-links</code> (the first-time setup does this for you).
          </p>
        )}
        {topics.map((t) => (
          <div key={t} className="mb-4">
            <h4 className="mb-2 font-semibold">{t}</h4>
            <ul className="space-y-2">
              {data.links.filter((l) => l.topic === t).map((l) => (
                <li key={l.url}>
                  <a className="text-[var(--color-brand)] underline" href={l.url} target="_blank" rel="noopener noreferrer">
                    {l.title}
                  </a>{' '}
                  <span className="muted text-sm">· {l.source} · {l.kind}</span>
                </li>
              ))}
            </ul>
          </div>
        ))}
        <p className="muted mt-2 text-xs">Links open in a new tab and were checked to work when added.</p>
      </Card>
    </div>
  )
}

export function Learn() {
  const { data, error } = useApi(api.learn)
  return (
    <div>
      <PageHeader
        title="Learn"
        intro="Every word the app uses, explained simply, plus answers to common beginner questions."
      />
      {error && <ErrorText>{error}</ErrorText>}
      {data && <LearnView data={data} />}
    </div>
  )
}
