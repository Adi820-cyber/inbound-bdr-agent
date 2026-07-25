/**
 * The single hardcoded inbound lead for the Inbound BDR Agent (Req 1.1).
 *
 * This file is the ONLY place in the repository that contains hardcoded lead
 * data. Everything downstream — qualification, research, matching, GTM, and the
 * handoff summary — is derived at runtime from this record (or from an arbitrary
 * alternative raw email supplied through the same Run trigger interface, per
 * Req 1.6). No other module may embed a company name, contact, or lead value.
 *
 * The record mirrors the Fixed_Lead defined in the requirements Glossary:
 *   sender name  : Rodrigo Castillo
 *   sender email : r.castillo@sqm.cl
 *   title        : Head of Operations, Northern Operations Division
 *   company      : Sociedad Quimica y Minera de Chile (SQM)
 *   country      : Chile
 *   subject      : Autonomous inspection for our Atacama lithium sites
 *
 * The body is a realistic inbound contact-form message consistent with every
 * stated fact. It names the Anglo American referral and the Q3 internal budget
 * conversation timeline so the lead normalizer can populate `referralSource`
 * and `statedTimeline` from the body text (Req 1.5).
 */

import type { RawEmailRecord } from "./contracts";

export const FIXED_LEAD: RawEmailRecord = {
  fromName: "Rodrigo Castillo",
  fromEmail: "r.castillo@sqm.cl",
  subject: "Autonomous inspection for our Atacama lithium sites",
  body: [
    "Hello,",
    "",
    "I'm Rodrigo Castillo, Head of Operations for the Northern Operations Division",
    "at Sociedad Quimica y Minera de Chile (SQM). We run large-scale lithium and",
    "potassium operations across the Atacama salt flat in northern Chile, and I'm",
    "looking into autonomous drone inspection for our sites.",
    "",
    "Our teams currently perform manual inspections of evaporation ponds, stockpiles,",
    "and fixed plant infrastructure across a very large, remote footprint. The manual",
    "approach is slow, it pulls people into hazardous areas, and the coverage we get",
    "is inconsistent. I want to understand how autonomous inspection could give us",
    "safer, more frequent, and more repeatable coverage of the Atacama lithium sites.",
    "",
    "Cristian at Anglo American recommended I reach out to FlytBase. He said your",
    "platform is what they lean on for autonomous drone operations, and that the",
    "experience of working with your team was a good one, so you came highly referred.",
    "",
    "On timing: we have a Q3 internal budget conversation coming up where I need to",
    "put forward the operational technology investments for next year. I'd like to go",
    "into that discussion with a clear view of what a deployment with FlytBase would",
    "involve, so it would help to connect in the next few weeks.",
    "",
    "Could you share how other mining and industrial operators have rolled this out,",
    "and what a first phase at a site like ours typically looks like?",
    "",
    "Best regards,",
    "Rodrigo Castillo",
    "Head of Operations, Northern Operations Division",
    "Sociedad Quimica y Minera de Chile (SQM)",
  ].join("\n"),
  formFields: {
    name: "Rodrigo Castillo",
    email: "r.castillo@sqm.cl",
    title: "Head of Operations, Northern Operations Division",
    company: "Sociedad Quimica y Minera de Chile (SQM)",
    country: "Chile",
  },
};
