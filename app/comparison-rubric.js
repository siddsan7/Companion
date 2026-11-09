// Accepted independent dimensions. These anchors are not a composite score or
// a numerical release gate. Examples use an unrelated calendar decision.
module.exports = {
  version: 1,
  note: 'Use 2 and 4 for intermediate outcomes. Flag unsupported claims or broken analogies even when surprise is high. A supported abstention can score well for grounding; explain usefulness and testability by the decision helped. A generation failure is not a grounded abstention. No composite score or numerical release threshold is selected.',
  dimensions: [
    { key: 'usefulness', label: 'Usefulness', anchors: ['No concrete project decision is helped', 'A relevant direction needs substantial clarification', 'Helps a concrete current MyTune decision'], example: 'For an unrelated calendar decision: a vague reminder is poor; a relevant scheduling direction needing detail is mixed; a concrete supported next choice is strong.' },
    { key: 'surprise', label: 'Surprise', anchors: ['Restates supplied material', 'Makes a modest non-obvious connection', 'Provides a distinct, non-obvious connection worth inspecting'], example: 'Repeating a stated deadline is poor; noticing a scheduling link is mixed; an unexpected useful connection is strong, provided it is grounded.' },
    { key: 'grounding', label: 'Grounding', anchors: ['Invents support or transfers a broken mechanism', 'Partially supported with identifiable gaps', 'Claims and transfer follow from supplied evidence and expose limits'], example: 'Inventing calendar availability is poor; citing incomplete availability is mixed; following supplied availability while naming gaps is strong.' },
    { key: 'easeOfTesting', label: 'Ease of testing', anchors: ['No feasible observable check', 'A test exists but needs substantial narrowing', 'A small feasible test has a clear observable result'], example: 'An undefined productivity claim is poor; a broad trial needing scope is mixed; one bounded check with an observable result is strong.' }
  ]
};
