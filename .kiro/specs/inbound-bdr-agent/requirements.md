# Requirements Document

## Introduction

The Inbound BDR Agent is a working, end-to-end web application that consumes one raw inbound contact-form email and autonomously produces the full artifact set a human inbound Business Development Representative would produce: lead qualification, deep account research grounded in real cited sources, an adaptive three-email response sequence, a discovered case-study match, a go-to-market motion recommendation, and an Account Executive handoff summary.

The system is built for the FlytBase BDR hackathon and must run on real data. The single fixed lead (Rodrigo Castillo, SQM, Chile) is the only hardcoded value in the system. All research, case-study discovery, matching, and recommendations are produced at runtime from live web sources, and every factual claim carries a resolvable source URL. Where a fact cannot be verified, the system reports `unknown` rather than inventing a value, because fabricated data is an automatic disqualifier under the hackathon brief.

The system is organized as six discrete, separately addressable stage modules driven by an orchestrator, so that each stage can be cited to a specific file in the repository, and each stage's inputs, reasoning, outputs, and sources are individually inspectable in the user interface and in the run log.

## Glossary

- **BDR_Agent**: The complete system described by this document, comprising the Orchestrator, the six Stage Modules, the Research_Toolbelt, the Run_Store, and the Run_Console.
- **Fixed_Lead**: The single hardcoded inbound email record containing sender name `Rodrigo Castillo`, sender email `r.castillo@sqm.cl`, title `Head of Operations, Northern Operations Division`, company `Sociedad Quimica y Minera de Chile (SQM)`, country `Chile`, subject `Autonomous inspection for our Atacama lithium sites`, and the raw body text supplied in the assignment brief.
- **Lead_Profile**: The structured, machine-readable representation of an inbound lead, derived from a raw email record, containing at minimum sender identity, title, company, country, industry, stated use case, stated pain points, referral source, and stated timeline.
- **Run**: One execution of the full six-stage pipeline for one Lead_Profile, identified by a unique Run_Id.
- **Orchestrator**: The module that accepts a Run trigger, executes the six Stage Modules in sequence, passes each stage's output to downstream stages, emits Stage_Events, and writes the Run_Artifact.
- **Stage_Module**: One of six independently addressable code modules: Stage_1_Qualifier, Stage_2_Researcher, Stage_3_Responder, Stage_4_Matcher, Stage_5_GTM_Advisor, Stage_6_Handoff_Generator.
- **Stage_1_Qualifier**: The Stage_Module that selects and applies one qualification framework and produces the Qualification_Result.
- **Stage_2_Researcher**: The Stage_Module that performs live account research and produces the Research_Report.
- **Stage_3_Responder**: The Stage_Module that produces the Email_Sequence.
- **Stage_4_Matcher**: The Stage_Module that discovers FlytBase case studies at runtime and produces the Match_Result.
- **Stage_5_GTM_Advisor**: The Stage_Module that produces the GTM_Recommendation.
- **Stage_6_Handoff_Generator**: The Stage_Module that produces the Handoff_Summary.
- **Qualification_Framework**: One of `MEDDPICC`, `BANT`, or `SPICED`, selected by Stage_1_Qualifier.
- **Qualification_Result**: The Stage 1 output containing the selected Qualification_Framework, the framework selection justification, the Known_Fields extracted from the Lead_Profile, the Unknown_Fields list, a Priority_Score, and the score reasoning.
- **Known_Fields**: The set of Qualification_Framework slots populated from information present in the Lead_Profile.
- **Unknown_Fields**: The set of Qualification_Framework slots that are not populated from the Lead_Profile and are required for full qualification.
- **Priority_Score**: An integer from 0 to 100 inclusive expressing lead fit and urgency.
- **Research_Report**: The Stage 2 output containing Research_Claims grouped into the five research dimensions plus a Positioning_Recommendation.
- **Research_Dimension**: One of `org_structure`, `budget_signals`, `recent_news`, `leadership_language`, `positioning`.
- **Research_Claim**: A single atomic factual statement produced by Stage_2_Researcher, carrying a claim text, a Research_Dimension, a Source_URL, a retrieved-at timestamp, and a Verification_Status.
- **Source_URL**: An absolute `http` or `https` URL that was fetched by the Research_Toolbelt during the current Run and that returned a success response.
- **Verification_Status**: One of `verified` (the claim text is supported by content retrieved from the Source_URL during this Run), `unknown` (no supporting source was retrieved), or `stale` (content was served from Cached_Corpus rather than a live fetch).
- **Unknown_Marker**: The literal string `unknown`, used as the value of any field for which no verified source was retrieved.
- **Positioning_Recommendation**: A synthesized narrative in the Research_Report stating how FlytBase should position to the account, with each supporting assertion linked to at least one Research_Claim.
- **Email_Sequence**: The Stage 3 output containing exactly three Email_Drafts and the Progression_Rationale for each.
- **Email_Draft**: One email addressed to the Lead_Profile contact, containing a subject line, a body, the set of Research_Claim identifiers it references, and the set of Unknown_Fields it is designed to surface.
- **Progression_Rationale**: An annotation on each Email_Draft after the first, explaining why that email follows the preceding email.
- **Case_Study_Record**: A structured record extracted from one FlytBase case-study page, containing source URL, title, industry, region, use case, named partner, and stated results, with the Unknown_Marker used for any field not present on the page.
- **Case_Study_Corpus**: The collection of Case_Study_Records assembled by Stage_4_Matcher for one Run.
- **Case_Study_Extractor**: The component that fetches FlytBase case-study pages and parses each into a Case_Study_Record.
- **Case_Study_Serializer**: The component that renders a Case_Study_Record back into its canonical serialized form.
- **Match_Score**: A numeric score in the closed interval 0.0 to 1.0 assigned to a Case_Study_Record for a given Lead_Profile.
- **Scoring_Rubric**: The published, attribute-driven set of weighted scoring dimensions (industry, geography, use case, referral or partner overlap) used to compute a Match_Score, defined independently of any specific company name or lead value.
- **Match_Result**: The Stage 4 output containing the ranked Case_Study_Corpus, the winning Case_Study_Record, the runner-up Case_Study_Record, and the per-dimension Scoring_Rubric breakdown for both.
- **GTM_Recommendation**: The Stage 5 output containing a GTM_Motion, the reasoning, the regional partner evidence found in FlytBase public material, and the recommended Partner_Type when the GTM_Motion is `partner_led`.
- **GTM_Motion**: One of `direct_ae` or `partner_led`.
- **Partner_Type**: A classification of the recommended partner category, such as `systems_integrator`, `drone_service_provider`, `hardware_reseller`, or `industrial_automation_consultancy`.
- **Handoff_Summary**: The Stage 6 output containing buyer context, qualification status, the top three research findings, the recommended case study with justification, and the suggested next step with rationale.
- **Research_Toolbelt**: The shared service layer providing web search and page fetch operations to Stage_Modules, and recording every request URL, response status, and retrieval timestamp.
- **Web_Search_Provider**: The configured external search API used by the Research_Toolbelt.
- **LLM_Provider**: The configured external large language model API used by Stage_Modules for extraction, scoring rationale, and generation.
- **Cached_Corpus**: A committed, timestamped snapshot of FlytBase public pages used only when live retrieval fails, with provenance recorded.
- **Stage_Event**: A structured, timestamped record emitted by the Orchestrator or a Stage_Module describing a stage lifecycle transition, a tool call, an intermediate reasoning step, or a stage output.
- **Run_Artifact**: The complete serialized record of one Run, containing the Lead_Profile, all six stage outputs, all Stage_Events, and all Source_URLs.
- **Run_Store**: The persistence component that writes and reads Run_Artifacts by Run_Id.
- **Run_Console**: The web user interface that triggers a Run, streams Stage_Events, and displays every stage output with its sources.
- **Secret_Value**: Any API key, token, or credential required by the Research_Toolbelt or LLM_Provider.

## Requirements

### Requirement 1: Fixed Lead Input and Lead Normalization

**User Story:** As a hackathon reviewer, I want the system to start from the exact inbound email in the assignment brief, so that I can compare its output against the brief without configuring anything.

#### Acceptance Criteria

1. THE BDR_Agent SHALL store the Fixed_Lead as the only hardcoded lead data in the repository.
2. WHEN a Run is triggered without a supplied lead, THE Orchestrator SHALL use the Fixed_Lead as the Run input.
3. WHEN a raw email record is supplied to the Orchestrator, THE Orchestrator SHALL derive a Lead_Profile from that record and use the derived Lead_Profile as the input to all six Stage_Modules.
4. WHERE a Lead_Profile field cannot be derived from the supplied raw email record, THE Orchestrator SHALL set that field to the Unknown_Marker.
5. WHEN the Fixed_Lead is normalized, THE Orchestrator SHALL populate the Lead_Profile referral source field with `Anglo American` and the stated timeline field with the Q3 internal budget conversation stated in the Fixed_Lead body.
6. THE BDR_Agent SHALL accept an arbitrary alternative raw email record through the same Run trigger interface used by the Fixed_Lead.

### Requirement 2: Single-Trigger End-to-End Orchestration

**User Story:** As a reviewer, I want one action to run all six stages, so that I can confirm there is no manual copy-paste between stages.

#### Acceptance Criteria

1. WHEN a reviewer submits the Run trigger in the Run_Console, THE Orchestrator SHALL execute Stage_1_Qualifier, Stage_2_Researcher, Stage_3_Responder, Stage_4_Matcher, Stage_5_GTM_Advisor, and Stage_6_Handoff_Generator in that order within a single Run.
2. WHEN the Run trigger is received through the Run API endpoint, THE Orchestrator SHALL execute the same six-stage sequence that the Run_Console trigger executes.
3. THE Orchestrator SHALL pass the output of each completed Stage_Module to the downstream Stage_Modules that declare a dependency on that output, without requiring any human input between stages.
4. WHEN all six Stage_Modules complete, THE Orchestrator SHALL mark the Run status as `complete` and write the Run_Artifact to the Run_Store.
5. IF a Stage_Module fails, THEN THE Orchestrator SHALL record the failure as a Stage_Event, mark that stage status as `failed`, continue executing the remaining Stage_Modules with the Unknown_Marker substituted for the missing upstream output, and mark the Run status as `partial`.
6. THE Orchestrator SHALL assign each Run a unique Run_Id.

### Requirement 3: Stage 1 Qualification

**User Story:** As an inbound BDR, I want the lead qualified against one explicit framework, so that I know what is known, what is missing, and how urgently to act.

#### Acceptance Criteria

1. THE Stage_1_Qualifier SHALL select exactly one Qualification_Framework from the set `MEDDPICC`, `BANT`, `SPICED`.
2. THE Stage_1_Qualifier SHALL emit a framework selection justification that references at least two attributes of the Lead_Profile.
3. WHEN Stage_1_Qualifier runs, THE Stage_1_Qualifier SHALL populate Known_Fields only from information present in the Lead_Profile.
4. WHEN Stage_1_Qualifier runs, THE Stage_1_Qualifier SHALL emit an Unknown_Fields list containing every slot of the selected Qualification_Framework that is absent from the Lead_Profile.
5. THE Stage_1_Qualifier SHALL emit a Priority_Score in the closed interval 0 to 100.
6. THE Stage_1_Qualifier SHALL emit score reasoning that names each factor contributing to the Priority_Score.
7. THE Stage_1_Qualifier SHALL emit a fit assessment classifying the lead as `strong_fit`, `moderate_fit`, or `weak_fit`.
8. WHEN the union of Known_Fields and Unknown_Fields is computed, THE Stage_1_Qualifier SHALL cover every slot of the selected Qualification_Framework exactly once.

### Requirement 4: Stage 2 Deep Account Research From Live Sources

**User Story:** As an AE, I want account research built from real public sources with citations, so that I can trust and reuse it in a customer conversation.

#### Acceptance Criteria

1. WHEN Stage_2_Researcher runs, THE Stage_2_Researcher SHALL issue at least one Research_Toolbelt search or fetch request for each Research_Dimension in the set `org_structure`, `budget_signals`, `recent_news`, `leadership_language`.
2. THE Stage_2_Researcher SHALL emit Research_Claims for the organizational structure and reporting lines relevant to the Lead_Profile title and division.
3. THE Stage_2_Researcher SHALL emit Research_Claims for budget signals drawn from public financial disclosures, including annual report or 20-F capital expenditure, operating expenditure, or technology investment figures, and the investor relations page of the account.
4. THE Stage_2_Researcher SHALL emit Research_Claims for news, press releases, or strategic announcements published by or about the account, covering the account's stated operating region, automation, and safety.
5. THE Stage_2_Researcher SHALL emit Research_Claims for leadership language drawn from investor letters, shareholder letters, or earnings-call material that reveals operational priorities.
6. THE Stage_2_Researcher SHALL emit a Positioning_Recommendation in which every assertion references at least one Research_Claim identifier.
7. WHEN a Research_Claim is emitted with Verification_Status `verified`, THE Stage_2_Researcher SHALL attach a Source_URL that the Research_Toolbelt fetched during the current Run and that returned a success response.
8. IF no supporting source is retrieved for a Research_Dimension, THEN THE Stage_2_Researcher SHALL emit a single Research_Claim for that dimension with claim text set to the Unknown_Marker and Verification_Status set to `unknown`.
9. THE Stage_2_Researcher SHALL attach a retrieved-at timestamp to every Research_Claim whose Verification_Status is `verified` or `stale`.

### Requirement 5: No Fabricated Data

**User Story:** As a hackathon reviewer, I want a hard guarantee that no factual claim is invented, so that the submission is not disqualified for fabrication.

#### Acceptance Criteria

1. THE BDR_Agent SHALL attach a Source_URL to every Research_Claim whose Verification_Status is `verified`.
2. IF a Research_Claim carries no Source_URL, THEN THE BDR_Agent SHALL set that Research_Claim Verification_Status to `unknown` and set its claim text to the Unknown_Marker.
3. IF a Source_URL attached to a Research_Claim was not requested by the Research_Toolbelt during the current Run, THEN THE Orchestrator SHALL reject that Research_Claim and record a validation Stage_Event naming the rejected URL.
4. WHEN the Run_Artifact is written, THE Orchestrator SHALL include the complete list of Source_URLs requested during the Run together with each response status code.
5. THE Run_Console SHALL render every Source_URL as a resolvable hyperlink next to the claim it supports.
6. WHERE a numeric figure appears in a Research_Claim, THE Stage_2_Researcher SHALL attach the Source_URL from which that figure was retrieved.
7. THE BDR_Agent SHALL display a limitations section in the Run_Console listing every Research_Dimension and field that resolved to the Unknown_Marker for the current Run.

### Requirement 6: Stage 3 Adaptive Response Sequence

**User Story:** As Rodrigo Castillo, I want emails that reflect my actual company situation and ask the right questions, so that replying feels worth my time.

#### Acceptance Criteria

1. WHEN Stage_3_Responder runs, THE Stage_3_Responder SHALL emit exactly three Email_Drafts addressed to the Lead_Profile contact.
2. THE Stage_3_Responder SHALL reference at least one Research_Claim identifier from the Research_Report in each Email_Draft.
3. THE Stage_3_Responder SHALL assign between one and two Unknown_Fields from the Qualification_Result to each Email_Draft as the information that Email_Draft is designed to surface.
4. WHEN the three Email_Drafts are combined, THE Stage_3_Responder SHALL cover at least three distinct Unknown_Fields across the Email_Sequence.
5. THE Stage_3_Responder SHALL emit a Progression_Rationale for the second and third Email_Drafts explaining why each follows the preceding Email_Draft.
6. THE Stage_3_Responder SHALL emit a persona adaptation note stating how tone and technical depth were adjusted for an operations-leader persona.
7. IF the Research_Report contains no Research_Claim with Verification_Status `verified`, THEN THE Stage_3_Responder SHALL emit Email_Drafts that reference only Lead_Profile facts and SHALL annotate the Email_Sequence with a research-unavailable notice.

### Requirement 7: Stage 4 Runtime Case Study Discovery and Extraction

**User Story:** As a reviewer, I want the case-study library discovered at runtime from flytbase.com, so that I can confirm the match is not a lookup table.

#### Acceptance Criteria

1. WHEN Stage_4_Matcher runs, THE Case_Study_Extractor SHALL retrieve the FlytBase case-studies index page at runtime and enumerate the case-study page URLs it links to.
2. THE Case_Study_Extractor SHALL parse each retrieved case-study page into a Case_Study_Record containing source URL, title, industry, region, use case, named partner, and stated results.
3. WHERE a Case_Study_Record field is absent from the retrieved page, THE Case_Study_Extractor SHALL set that field to the Unknown_Marker.
4. THE Case_Study_Serializer SHALL render any Case_Study_Record into its canonical serialized form.
5. WHEN a Case_Study_Record is serialized by the Case_Study_Serializer and then parsed by the Case_Study_Extractor, THE Case_Study_Extractor SHALL produce a Case_Study_Record equal to the original record.
6. IF live retrieval of the FlytBase case-studies index fails, THEN THE Case_Study_Extractor SHALL load the Case_Study_Corpus from the Cached_Corpus, set the Verification_Status of every affected Case_Study_Record to `stale`, and record the Cached_Corpus snapshot timestamp as a Stage_Event.
7. IF live retrieval fails and no Cached_Corpus is available, THEN THE Stage_4_Matcher SHALL mark the stage status as `failed` and set the Match_Result to the Unknown_Marker.
8. THE Stage_4_Matcher SHALL record the retrieved URL and response status of every case-study page request as Stage_Events.

### Requirement 8: Stage 4 Attribute-Driven Matching Without Hardcoded Logic

**User Story:** As a reviewer, I want the winning case study chosen by a published scoring rubric over lead attributes, so that the logic generalizes beyond this one lead.

#### Acceptance Criteria

1. THE Stage_4_Matcher SHALL compute each Match_Score from the Scoring_Rubric using only Lead_Profile attribute values and Case_Study_Record field values as inputs.
2. THE Stage_4_Matcher SHALL score every Case_Study_Record in the Case_Study_Corpus against the Lead_Profile industry, the Lead_Profile geography, the Lead_Profile stated use case, and the Lead_Profile referral source.
3. THE Stage_4_Matcher SHALL emit a per-dimension Scoring_Rubric breakdown with a numeric contribution for each scoring dimension for the winning and runner-up Case_Study_Records.
4. THE Stage_4_Matcher SHALL emit the winning Case_Study_Record, the runner-up Case_Study_Record, and the ranked Case_Study_Corpus with each Match_Score.
5. THE Stage_4_Matcher SHALL emit a comparison statement explaining why the winning Match_Score exceeded the runner-up Match_Score on at least one scoring dimension.
6. THE Stage_4_Matcher SHALL produce a Match_Score in the closed interval 0.0 to 1.0 for every Case_Study_Record.
7. WHEN two Runs use Lead_Profiles that differ in industry or geography and share the same Case_Study_Corpus, THE Stage_4_Matcher SHALL produce Scoring_Rubric breakdowns that differ in at least one dimension contribution.
8. THE BDR_Agent SHALL exclude any conditional branch keyed to a specific company name, lead email address, or referral organization name from the Stage_4_Matcher and Stage_5_GTM_Advisor scoring paths.
9. IF the Case_Study_Corpus contains fewer than two Case_Study_Records, THEN THE Stage_4_Matcher SHALL emit the available records, set the runner-up to the Unknown_Marker, and record a Stage_Event stating the corpus size.

### Requirement 9: Stage 5 Partner and GTM Motion Recommendation

**User Story:** As a sales leader, I want a reasoned direct-versus-partner recommendation grounded in FlytBase public material, so that routing this deal is defensible.

#### Acceptance Criteria

1. WHEN Stage_5_GTM_Advisor runs, THE Stage_5_GTM_Advisor SHALL issue at least one Research_Toolbelt request against FlytBase public material for partner-ecosystem signals in the Lead_Profile geography.
2. THE Stage_5_GTM_Advisor SHALL emit a GTM_Motion of either `direct_ae` or `partner_led`.
3. THE Stage_5_GTM_Advisor SHALL emit reasoning that references the Lead_Profile geography, an assessment of deal complexity, and the presence or absence of a relevant regional partner in FlytBase public material.
4. WHERE the GTM_Motion is `partner_led`, THE Stage_5_GTM_Advisor SHALL emit a Partner_Type and the Source_URL of the FlytBase material supporting the partner assessment.
5. IF no regional partner signal is retrieved from FlytBase public material, THEN THE Stage_5_GTM_Advisor SHALL set the regional partner evidence field to the Unknown_Marker and SHALL state that the GTM_Motion was derived without regional partner evidence.
6. THE Stage_5_GTM_Advisor SHALL derive the GTM_Motion from Lead_Profile attribute values and retrieved partner evidence rather than from the Lead_Profile company name.

### Requirement 10: Stage 6 AE Handoff Summary

**User Story:** As an AE picking up this lead, I want a single scannable artifact, so that I can act within two minutes of reading it.

#### Acceptance Criteria

1. WHEN Stage_6_Handoff_Generator runs, THE Stage_6_Handoff_Generator SHALL emit a Handoff_Summary containing a buyer context section, a qualification status section, a top-three research findings section, a recommended case study section, and a suggested next step section.
2. THE Stage_6_Handoff_Generator SHALL include the Priority_Score, the Known_Fields count, and the Unknown_Fields list in the qualification status section.
3. THE Stage_6_Handoff_Generator SHALL include exactly three Research_Claims in the top-three research findings section, each with its Source_URL.
4. THE Stage_6_Handoff_Generator SHALL include the winning Case_Study_Record source URL and the reason it won in the recommended case study section.
5. THE Stage_6_Handoff_Generator SHALL include a suggested next step and the rationale for that next step, consistent with the GTM_Motion emitted by Stage_5_GTM_Advisor.
6. THE Stage_6_Handoff_Generator SHALL restrict the Handoff_Summary to content derived from the outputs of Stages 1 through 5.
7. IF fewer than three Research_Claims with Verification_Status `verified` are available, THEN THE Stage_6_Handoff_Generator SHALL fill the remaining research findings entries with the Unknown_Marker and SHALL state the number of verified findings available.

### Requirement 11: Stage Transparency and Inspectable Reasoning

**User Story:** As a reviewer, I want to see each stage's inputs, tool calls, reasoning, and outputs, so that I can evaluate the thinking and not just a final blob.

#### Acceptance Criteria

1. WHEN a Stage_Module starts, THE Orchestrator SHALL emit a Stage_Event containing the stage name, the Run_Id, a timestamp, and the stage input summary.
2. WHEN a Stage_Module issues a Research_Toolbelt request, THE Research_Toolbelt SHALL emit a Stage_Event containing the request URL or search query, the response status, and the retrieval timestamp.
3. WHEN a Stage_Module completes, THE Orchestrator SHALL emit a Stage_Event containing the stage name, the stage status, and the complete stage output.
4. THE Run_Console SHALL display each of the six stage outputs in a separately expandable section labelled with the stage number and stage name.
5. THE Run_Console SHALL display the Stage_Events for each stage alongside that stage's output.
6. THE BDR_Agent SHALL write every Stage_Event of a Run into the Run_Artifact.
7. THE Run_Console SHALL display the selected Qualification_Framework justification, the Scoring_Rubric breakdown, and the Progression_Rationale as visible text rather than collapsed internal state.

### Requirement 12: Streaming Web User Interface

**User Story:** As a reviewer, I want to watch the stages populate as they run, so that a long-running pipeline is observable rather than a blank wait.

#### Acceptance Criteria

1. THE Run_Console SHALL present a single control that triggers a Run for the Fixed_Lead.
2. WHEN a Run is in progress, THE Run_Console SHALL render each Stage_Event within 2 seconds of the Orchestrator emitting that Stage_Event.
3. WHILE a Stage_Module is executing, THE Run_Console SHALL display that stage status as `running`.
4. WHEN a Stage_Module completes, THE Run_Console SHALL display that stage output without requiring a page reload.
5. IF the event stream between the Orchestrator and the Run_Console is interrupted, THEN THE Run_Console SHALL display a stream-interrupted notice and SHALL offer a control to reload the Run_Artifact for the current Run_Id.
6. THE Run_Console SHALL display the Run status as `running`, `complete`, `partial`, or `failed`.
7. THE Run_Console SHALL allow a reviewer to submit an alternative raw email record in place of the Fixed_Lead.

### Requirement 13: Modular Stage Architecture and Codebase Traceability

**User Story:** As the submission author, I want each stage to map to one clearly named module, so that my writeup can cite a specific file per stage.

#### Acceptance Criteria

1. THE BDR_Agent SHALL implement each of the six Stage_Modules in a separate source file whose name identifies its stage number and stage purpose.
2. THE BDR_Agent SHALL implement the Orchestrator in a source file separate from all six Stage_Module files.
3. THE BDR_Agent SHALL implement the Research_Toolbelt in a source file separate from all six Stage_Module files.
4. THE BDR_Agent SHALL restrict all external web search and page fetch calls to the Research_Toolbelt.
5. THE BDR_Agent SHALL define each stage input type and stage output type in a shared contracts module referenced by the Orchestrator and the Stage_Modules.
6. THE README SHALL contain a table mapping each of the six stages to its source file path.

### Requirement 14: Secret and Configuration Management

**User Story:** As the repository owner, I want no credentials in the repo, so that the project can be pushed to a public GitHub repository safely.

#### Acceptance Criteria

1. THE BDR_Agent SHALL read every Secret_Value from an environment variable at runtime.
2. THE BDR_Agent SHALL exclude files containing Secret_Values from version control through a `.gitignore` entry covering `.env` files.
3. THE BDR_Agent SHALL provide a `.env.example` file listing every required environment variable name with a placeholder value and a one-line description.
4. IF a required environment variable is absent when a Run is triggered, THEN THE Orchestrator SHALL mark the Run status as `failed` and SHALL emit a Stage_Event naming the missing environment variable.
5. THE BDR_Agent SHALL exclude Secret_Values from Stage_Events, the Run_Artifact, and the Run_Console.
6. THE BDR_Agent SHALL expose no Secret_Value to browser-executed code.

### Requirement 15: Repository, Documentation, and Deployment

**User Story:** As a hackathon reviewer, I want a clear README and a single live link, so that I can evaluate the submission without a local setup.

#### Acceptance Criteria

1. THE BDR_Agent SHALL be initialized as a git repository with an initial commit containing the full application source.
2. THE README SHALL state what the system does, the six-stage architecture, the local run command, the required environment variables, and the deployment target.
3. THE README SHALL state the known limitations of the current implementation, including every dependency on live third-party retrieval.
4. THE BDR_Agent SHALL run from a single deployment on a hosting platform that serves both the Run_Console and the Run API endpoint from one public URL.
5. WHEN the deployed public URL is opened, THE Run_Console SHALL load and present the Run trigger control without requiring reviewer configuration.
6. THE BDR_Agent SHALL complete a Run within the request-duration limit of the configured hosting platform, or SHALL stream Stage_Events over a connection that the hosting platform sustains for the Run duration.

### Requirement 16: Run Persistence and Shareable Results

**User Story:** As the submission author, I want a completed run to be retrievable by URL, so that I can link a reviewer to a specific finished run.

#### Acceptance Criteria

1. WHEN a Run reaches status `complete` or `partial`, THE Run_Store SHALL persist the Run_Artifact under the Run_Id.
2. WHEN a reviewer requests a Run_Id that exists in the Run_Store, THE Run_Console SHALL render the stored Run_Artifact including all six stage outputs, all Stage_Events, and all Source_URLs.
3. IF a reviewer requests a Run_Id that is absent from the Run_Store, THEN THE Run_Console SHALL display a run-not-found notice.
4. WHEN a Run_Artifact is serialized by the Run_Store and then deserialized by the Run_Store, THE Run_Store SHALL produce a Run_Artifact equal to the original Run_Artifact.
5. THE Run_Store SHALL persist Run_Artifacts through a storage backend that survives a redeployment of the application.

### Requirement 17: Graceful Degradation and Error Handling

**User Story:** As a reviewer, I want the system to report gaps honestly when a source is unavailable, so that partial results remain trustworthy.

#### Acceptance Criteria

1. IF a Research_Toolbelt request returns a non-success response, THEN THE Research_Toolbelt SHALL emit a Stage_Event containing the request URL and the response status and SHALL return an empty result to the calling Stage_Module.
2. IF a Research_Toolbelt request exceeds the configured request timeout, THEN THE Research_Toolbelt SHALL abort that request, emit a timeout Stage_Event, and return an empty result to the calling Stage_Module.
3. IF the Web_Search_Provider is unreachable for the duration of a Run, THEN THE Orchestrator SHALL complete the Run with status `partial` and SHALL set every unsupported Research_Claim to the Unknown_Marker.
4. IF the LLM_Provider returns a response that fails validation against the stage output contract, THEN THE Orchestrator SHALL retry that Stage_Module at most twice and SHALL mark the stage status as `failed` after the final failed attempt.
5. WHEN a Stage_Module returns a field for which no source was retrieved, THE Orchestrator SHALL accept the Unknown_Marker for that field and SHALL record the substitution as a Stage_Event.
6. THE BDR_Agent SHALL exclude any placeholder, sample, or illustrative factual value from stage outputs when retrieval fails.
