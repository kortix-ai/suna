import type { RoleContent } from '../types';

/** Accuracy gate: `../types.ts`. Read it before editing. */
export const dataScience: RoleContent = {
  slug: 'data-science',
  name: 'Data Science',
  navDescription: 'A real machine, a real query, an analysis you can re-run',
  seoTitle: 'dosco for data science teams',
  seoDescription:
    'Every dosco session is a real Linux machine, so an analysis agent can install a package, run the query, and commit the notebook. The analysis lands in the repo as a change request, so it can be re-run.',

  hero: {
    title: 'An analysis you can re-run, not a number in a chat window.',
    sub: 'A session is a real Linux machine. The agent installs what it needs, runs the query, does the work in a script you can read, and commits it. What lands is the analysis and the code that produced it — reproducible by definition, because it is a file in your repo.',
    microline: 'Real shell · real packages · the notebook lands in the repo',
    specs: [
      { k: 'Runs on', v: 'A real machine with a shell' },
      { k: 'Installs', v: 'Whatever the analysis needs' },
      { k: 'Lands as', v: 'A change request against main' },
      { k: 'Re-runnable', v: 'Because the code came with it' },
    ],
  },

  handoff: {
    title: 'The requests that arrive faster than you can answer them.',
    sub: 'Most of the queue is not modelling. It is the fourth variation of a question someone already asked, a pipeline that broke overnight, or a definition of "active" that three teams disagree about. That queue is the handoff.',
    jobs: [
      {
        id: 'adhoc',
        title: 'The ad-hoc question, answered with its query attached',
        body: 'Somebody asks what happened to conversion in week 27. It writes the query, runs it, checks the result against a second cut, and answers with both the number and the SQL. The next person to ask does not need you either.',
      },
      {
        id: 'break',
        title: 'The pipeline that failed at 03:00',
        body: 'It reads the failure, reproduces the transformation on its own machine against a sample, finds the row shape that broke it, and opens a change request with the fix and a test that would have caught it.',
      },
      {
        id: 'quality',
        title: 'Data quality sweeps, on a schedule',
        body: 'Nulls where there should not be, distributions that shifted, joins that started fanning out, a dimension that grew 40% overnight. It reports what moved and what it thinks moved it — and says when it does not know.',
      },
      {
        id: 'definitions',
        title: 'The metric definition audit',
        body: 'It finds every place a metric is computed, diffs the definitions against each other, and reports where they disagree. This is unglamorous, genuinely hard to schedule, and the reason two dashboards show different revenue.',
      },
      {
        id: 'notebook',
        title: 'The exploratory pass before you take over',
        body: 'Profile the dataset, plot the distributions, check for leakage and imbalance, and write the first honest paragraph about what is in the data. You start from a briefed position rather than from an empty cell.',
      },
      {
        id: 'refresh',
        title: 'The recurring analysis nobody wants to own',
        body: 'The weekly cohort cut, the monthly retention curve, the quarterly segment refresh. Same code, new period, run by a trigger, landing as a change request with the chart regenerated.',
      },
    ],
  },

  output: {
    title: 'The query, in a file, on a branch.',
    sub: 'A chat answer is unfalsifiable and unrepeatable. So an analysis session commits its work: the query, the script, the notebook, the chart, and the note about what it checked. That is what arrives for review.',
    artifact: {
      kind: 'code',
      file: 'analysis/wk27-conversion/query.sql',
      lang: 'sql',
      lines: [
        '-- Week 27 conversion, split by first-touch surface.',
        '-- Excludes internal domains: they run the smoke suite hourly and',
        '-- accounted for 4.1% of week-27 signups before this filter.',
        'with first_touch as (',
        '  select account_id,',
        '         min(occurred_at)                       as first_seen,',
        '         argmin(surface, occurred_at)           as surface',
        '    from events',
        '   where occurred_at >= date "2026-06-29"',
        '     and email not like "%@acme-internal.example"',
        '   group by account_id',
        ')',
        'select surface,',
        '       count(*)                                  as accounts,',
        '       countif(converted_at is not null)         as converted,',
        '       round(countif(converted_at is not null)',
        '             / count(*), 4)                      as rate',
        '  from first_touch join accounts using (account_id)',
        ' group by surface',
        ' order by accounts desc;',
      ],
    },
    caption:
      'Illustration. The excluded domain is a placeholder — dosco never names a real customer or tenant.',
    notes: [
      {
        id: 'shell',
        title: 'It is a real machine, not a tool sandbox',
        body: 'The agent has a shell and a filesystem. It can install a package, pull a sample down, run it, look at the output, and try again — the loop an analyst actually works in, rather than one shot at a fixed set of tools.',
      },
      {
        id: 'reproducible',
        title: 'Reproducible because the code came with it',
        body: 'The answer and the thing that produced the answer arrive together in the same change request. Re-running it next month is a re-run, not a reconstruction.',
      },
      {
        id: 'honest',
        title: 'It writes down what it excluded',
        body: 'The filters, the date boundaries, the rows it dropped and why. An analysis whose exclusions are undocumented is not an analysis, and a comment in the query is the cheapest possible place to keep them.',
      },
    ],
  },

  reach: {
    title: 'Your warehouse, however it is actually reachable.',
    sub: 'We are not going to list a row of warehouse logos we have not verified. Here is what is genuinely true about how an analysis session reaches data, including the part where it does the work locally.',
    rows: [
      {
        k: 'The machine itself',
        v: 'The strongest data connector on this page is the sandbox. Pull an extract down, work on it locally with whatever you would normally use, and never move the analysis into a tool that cannot do arithmetic.',
      },
      {
        k: 'Your warehouse and BI stack',
        v: 'Reached as a connector you define: an OpenAPI or Postman description, a GraphQL endpoint, a raw HTTP base URL, or a remote MCP server. dosco reads the source, works out the authentication, and turns each operation into a tool with its own Allow, Ask or Block.',
      },
      {
        k: 'The repo',
        v: 'Cloned at session start on a fresh branch. Your transformation code, your metric definitions and your previous analyses are already there — which is why the agent can check a new definition against the existing one instead of inventing a third.',
      },
      {
        k: 'Google Sheets and Drive',
        v: 'Because half of the real inputs to an analysis are a spreadsheet somebody maintains by hand. It reads them as source and writes the output back where the requester will look for it.',
      },
      {
        k: 'Slack',
        v: 'The one live channel. Ask the question in the thread where it came up; the answer, the chart and the query come back into the same thread.',
      },
    ],
    footnote:
      'Easy connect covers 3,000+ apps through their own OAuth screens, and it is the right route for the SaaS sources around the edges of a data stack. For the warehouse itself the direct connector types are usually the honest answer — most warehouses are reached through a driver or an API, not an OAuth catalogue entry.',
  },

  cadence: {
    title: 'Answer it now, check the writes, refresh it on a schedule.',
    sub: 'The same session machinery started three ways. The isolation and the review path do not change with the trigger.',
    modes: [
      {
        id: 'on-demand',
        label: 'On demand',
        title: 'The question, in the thread it was asked in',
        body: 'Somebody asks in a channel. The mention starts a session, the session does the work on its own machine, and the answer lands back in the same thread with the query attached.',
      },
      {
        id: 'human-assisted',
        label: 'Human-assisted',
        title: 'Reads run, writes wait',
        body: 'Set the read actions to Allow and anything that writes to a warehouse or overwrites a table to Ask. The run pauses at the call with the statement in front of you and resumes from that exact point when you approve.',
      },
      {
        id: 'automated',
        label: 'Automated',
        title: 'The refresh, and the quality sweep',
        body: 'A cron trigger re-runs the recurring analysis against the new period and opens a change request with the regenerated output. A second one runs the quality sweep and only says something when a check fails.',
      },
    ],
  },

  control: {
    title: 'What it can read, and what it can overwrite.',
    sub: 'An analysis agent is mostly a read problem — right up until the moment it is not. Be exact about both halves.',
    rows: [
      {
        id: 'gates',
        k: 'Approval gates are off until you set them',
        v: 'The shipped default is permissive: an action runs unless you have said otherwise. Reads are usually fine that way. Writes to a warehouse are not, and setting them to Ask is a configuration change you make, not one that was made for you.',
      },
      {
        id: 'scope',
        k: 'Reach is granted per agent, not inherited',
        v: 'An agent gets the connectors you list for it and nothing else, and it cannot discover that the others exist. The analysis agent reaching the warehouse and the support agent reaching the helpdesk are separate grants in kortix.yaml.',
      },
      {
        id: 'merge',
        k: 'Merge is default-deny',
        v: 'The notebook, the query and the fix land through a change request against main. An agent cannot merge unless an admin has granted project.cr.merge in kortix.yaml, and widening that grant is itself a reviewed change.',
      },
      {
        id: 'secrets',
        k: 'Two kinds of credential, stated precisely',
        v: 'A connector credential is brokered server-side and never enters the machine. A runtime secret you deliberately grant a session IS a real environment value inside it, readable by any command the agent runs — that is what granting it means, and it is worth knowing before you grant a warehouse password rather than a connector.',
      },
      {
        id: 'isolation',
        k: 'One machine per session',
        v: 'Sessions do not share a working tree or a filesystem. An extract pulled into one session is not visible to another, and the machine is disposable.',
      },
    ],
  },

  closing: {
    title: 'Clear the queue that is not modelling.',
    sub: 'Open source and self-hostable. Any model, your keys. dosco Cloud, your own VPC, or your own on-prem network.',
  },
};
