globalThis.FOLIO_SOURCES = {
  "version": "ontario-ed-2026-09-21",
  "checkedOn": "2026-09-21",
  "laminaCommit": "6201fe4abdf019771eaab68655431039308fc947",
  "profile": {
    "id": "cvh-ed",
    "payer": "OHIP",
    "jurisdiction": "Ontario",
    "ecgInterpretation": false,
    "assessmentDefault": "multisystem"
  },
  "coverage": "Focused ED package. These guidance checks cover time recording, aggregation, and critical-care exclusions; they do not verify every fee, current rate, or all eligibility conditions.",
  "sources": [
    {
      "key": "time-requirements",
      "title": "Requirements for time-based services",
      "url": "https://www.ontario.ca/document/education-and-prevention-committee-billing-briefs/requirements-time-based-services",
      "rules": [
        "R010",
        "R011"
      ],
      "anchor": "times when the time-based service started and ended",
      "summary": "The physician must record service start and stop times in the permanent medical record. Critical-care units can combine non-consecutive active-care intervals. A proposed reconstruction helps complete that record; its estimates are not recorded measurements.",
      "sourceId": "src_c30c9239cee1b95efc2d",
      "textSha256": "c30c9239cee1b95efc2d565e13896e886383a0a8d7fa84f541010d3b5d9f3fd6",
      "htmlSha256": "33080f45811aef9574448faabb74873f288fc4afdf6b723b65a302b57401d3ae",
      "unitId": "unit_116b435ede09c4182b08",
      "locator": "lines 35–51",
      "quote": "times when the time-based service started and ended",
      "checkedOn": "2026-09-21",
      "kind": "official-guidance-with-editorial-summary"
    },
    {
      "key": "time-examples",
      "title": "Time-based services: case-based billing guidance",
      "url": "https://www.ontario.ca/document/education-and-prevention-committee-billing-briefs/time-based-services-case-based-billing",
      "rules": [
        "R010",
        "R011",
        "R012"
      ],
      "anchor": "time they actually spend evaluating, managing, and providing care",
      "summary": "Critical-care time includes the physician's active evaluation and management, including appropriate work away from the bedside while immediately available. Exclude other-patient work and time spent on separately payable procedures. Included assessments, monitoring and procedures are not added again. The published examples illustrate both a 75-minute resuscitation and removal of chest-tube procedure time.",
      "sourceId": "src_9988126592cc0aafcf76",
      "textSha256": "9988126592cc0aafcf76f9cef4cc254048ea205edb29594622de6c680d2fbe96",
      "htmlSha256": "af47518b33bce1e9ac7920130c7420ecdc76f4cce863bf419819b61d39b08450",
      "unitId": "unit_ecf5075ac116b74d156a",
      "locator": "lines 199–215",
      "quote": "time they actually spend evaluating, managing, and providing care",
      "checkedOn": "2026-09-21",
      "kind": "official-guidance-with-editorial-summary"
    }
  ],
  "ruleEvidence": {
    "R010": [
      "time-requirements",
      "time-examples"
    ],
    "R011": [
      "time-requirements",
      "time-examples"
    ],
    "R012": [
      "time-examples"
    ]
  },
  "bundleSha256": "68948e69e7f84b01430cd5ecffff09187f806a8898925891cf07d3c95b313f22"
};
if(typeof module==="object"&&module.exports) module.exports=globalThis.FOLIO_SOURCES;
