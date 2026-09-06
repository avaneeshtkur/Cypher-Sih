// Authored demonstration cases. `reference` and `why` are presentation metadata;
// callers pass only `turns` to the assessment engine.
export const CALL_CASES=Object.freeze([
  {
    id:'cfo-payment-pressure',title:'CFO payment pressure',reference:'scam-like',
    summary:'Executive impersonation pushes an urgent transfer to a changed account.',
    why:'Combines authority, urgency, a new beneficiary, approval bypass, secrecy and blocked callback.',
    turns:[
      {role:'caller',text:'This is the CFO. Transfer 20 lakh within the next twenty minutes.'},
      {role:'employee',text:'I need to confirm the beneficiary with finance.'},
      {role:'caller',text:"Use the new account details. Skip the usual approval. Don't call me back. Keep this between us."}
    ],audio:'payment-pressure'
  },
  {
    id:'digital-arrest',title:'Digital-arrest coercion',reference:'scam-like',
    summary:'A fake police officer threatens arrest and demands a verification transfer.',
    why:'Authority and legal threats are combined with payment, secrecy and an attempt to bypass verification.',
    turns:[
      {role:'caller',text:'This is the police officer handling your case. An arrest warrant is ready and your account will be blocked.'},
      {role:'employee',text:'Can I call the station on the published number?'},
      {role:'caller',text:'Transfer the money to the verification account now. Do not tell anyone. Skip the usual approval.'}
    ],audio:'digital-arrest'
  },
  {
    id:'otp-secrecy',title:'Bank OTP extraction',reference:'scam-like',
    summary:'A caller claims to secure an account while requesting a one-time password.',
    why:'Credential extraction becomes strongly suspicious when paired with secrecy and blocked verification.',
    turns:[
      {role:'caller',text:'I am the bank security officer. Your account is at risk and we need to act immediately.'},
      {role:'employee',text:'I will call the bank back using the number on my card.'},
      {role:'caller',text:"Do not call back. Read me the OTP now and don't tell your manager."}
    ]
  },
  {
    id:'remote-support',title:'Remote-support takeover',reference:'scam-like',
    summary:'Fake technical support claims malware and asks for remote access.',
    why:'Institutional impersonation and a device threat lead to remote-access installation while verification is discouraged.',
    turns:[
      {role:'caller',text:'This is John from Microsoft Technical Support. Your computer has been infected with malware.'},
      {role:'employee',text:'I will ask our IT helpdesk to check the ticket.'},
      {role:'caller',text:'Do not disconnect. Install AnyDesk and give me remote access immediately.'}
    ]
  },
  {
    id:'refund-fee',title:'Refund processing fee',reference:'scam-like',
    summary:'A promised refund is conditioned on an immediate payment.',
    why:'A reward lure, urgency and a sensitive payment are reinforced by isolation.',
    turns:[
      {role:'caller',text:'You have a refund pending for an unauthorized transaction.'},
      {role:'employee',text:'I will verify that in the official app.'},
      {role:'caller',text:"Send 2,000 rupees as the processing fee immediately and don't call the bank back until I release the refund."}
    ]
  },
  {
    id:'vendor-change',title:'Vendor bank-detail change',reference:'scam-like',
    summary:'A supposed supplier requests payment to a newly changed beneficiary.',
    why:'The financial action is paired with a new account, urgency, secrecy and approval bypass.',
    turns:[
      {role:'caller',text:'Our bank details changed. Send today’s invoice payment to the new beneficiary immediately.'},
      {role:'employee',text:'I need normal approval and a callback to our saved vendor contact.'},
      {role:'caller',text:'Skip the approval this once and keep the account change between us.'}
    ]
  },

  {
    id:'approved-supplier-payment',title:'Urgent supplier payment with controls',reference:'genuine',
    summary:'A real urgent payment still follows callback and approval controls.',
    why:'Urgency and payment language are countered by explicit normal approval and independent callback instructions.',
    turns:[
      {role:'caller',text:'The supplier invoice is urgent, but please complete the usual approval.'},
      {role:'employee',text:'I will verify the beneficiary before processing it.'},
      {role:'caller',text:'Yes. Call the vendor on our saved number and follow the normal procedure.'}
    ],audio:'legitimate-payment'
  },
  {
    id:'bank-fraud-alert',title:'Bank fraud alert with safe callback',reference:'genuine',
    summary:'A bank employee asks the customer to use official channels and share no credentials.',
    why:'Protective credential advice and a registered-number callback support verification rather than compliance.',
    turns:[
      {role:'caller',text:'This is a fraud alert about a card transaction. Do not share your OTP or PIN with anyone.'},
      {role:'employee',text:'How should I verify this alert?'},
      {role:'caller',text:'End this call and contact the bank using the official number printed on your card.'}
    ]
  },
  {
    id:'scheduled-it-ticket',title:'Scheduled IT support ticket',reference:'genuine',
    summary:'Internal support references an existing ticket and forbids password sharing.',
    why:'The request points to an approved helpdesk workflow without remote-control or credential demands.',
    turns:[
      {role:'caller',text:'I am calling about IT ticket 4812 for tomorrow’s software update.'},
      {role:'employee',text:'Should I verify it in the helpdesk portal?'},
      {role:'caller',text:'Yes. Use the approved portal and never share your password or OTP.'}
    ]
  },
  {
    id:'payroll-update',title:'Payroll account update via HR portal',reference:'genuine',
    summary:'An employee is directed to the authenticated HR workflow for a bank change.',
    why:'Although account details change, the caller requires normal procedure rather than bypassing it.',
    turns:[
      {role:'caller',text:'Your updated account details must be submitted through the authenticated HR portal.'},
      {role:'employee',text:'Will payroll review the change?'},
      {role:'caller',text:'Yes. Complete the standard approval and wait for payroll confirmation before any payment.'}
    ]
  },
  {
    id:'delivery-confirmation',title:'Delivery confirmation',reference:'genuine',
    summary:'A courier confirms a delivery window without requesting credentials or money.',
    why:'No sensitive action or manipulation combination is present.',
    turns:[
      {role:'caller',text:'Hello, your office parcel is scheduled for delivery between two and four tomorrow.'},
      {role:'employee',text:'Please leave it with reception.'},
      {role:'caller',text:'Certainly. The tracking page will show the completed delivery.'}
    ]
  },
  {
    id:'appointment-reminder',title:'Appointment reminder',reference:'genuine',
    summary:'A clinic confirms an existing appointment and offers an official callback.',
    why:'Ordinary scheduling contains no sensitive request, secrecy, threat or bypass.',
    turns:[
      {role:'caller',text:'This is a reminder for your appointment with Dr. Rao tomorrow at ten.'},
      {role:'employee',text:'Can I reschedule?'},
      {role:'caller',text:'Yes. Call the clinic reception on the number in your appointment message.'}
    ]
  },

  {
    id:'urgent-invoice-only',title:'Urgent invoice without control context',reference:'unclear',
    summary:'A known-sounding supplier asks for same-day payment but does not block verification.',
    why:'The action and urgency warrant verification, but there is no secrecy, bypass or independent identity evidence.',
    turns:[
      {role:'caller',text:'The invoice payment is urgent. Can you process it today?'},
      {role:'employee',text:'I need to check the purchase order and beneficiary.'},
      {role:'caller',text:'Okay, let me know after you have checked it.'}
    ]
  },
  {
    id:'refund-notice-official-app',title:'Refund notice via official app',reference:'unclear',
    summary:'A refund is announced, but the caller asks the recipient to verify independently.',
    why:'The reward topic is scam-associated in the synthetic corpus, while the requested verification behavior is protective.',
    turns:[
      {role:'caller',text:'A refund may be pending on your card account.'},
      {role:'employee',text:'Do you need any information from me?'},
      {role:'caller',text:'No. Check the official banking app or call the number on your card. Do not share an OTP.'}
    ]
  },
  {
    id:'kyc-app-reminder',title:'KYC reminder with no credentials',reference:'unclear',
    summary:'A KYC deadline is mentioned, but completion is directed to the official app.',
    why:'Account-action wording deserves review; the absence of OTP/payment and use of an official channel lower concern.',
    turns:[
      {role:'caller',text:'Your KYC verification is due this month.'},
      {role:'employee',text:'Can I do that without this call?'},
      {role:'caller',text:'Yes. End the call and use the official bank app. Never share your password.'}
    ]
  },
  {
    id:'new-beneficiary-with-approval',title:'New beneficiary with normal approval',reference:'unclear',
    summary:'A legitimate-looking account change still requires extra scrutiny.',
    why:'New beneficiary and payment language remain sensitive even when the caller accepts standard approval.',
    turns:[
      {role:'caller',text:'The next invoice should use our new beneficiary account.'},
      {role:'employee',text:'I will call our saved contact and obtain manager approval.'},
      {role:'caller',text:'That is correct. Please follow the normal approval process before sending payment.'}
    ]
  },
  {
    id:'prize-survey',title:'Prize survey without a demand',reference:'unclear',
    summary:'A prize is mentioned, but no money or credential is requested yet.',
    why:'Reward language is a warning cue, but the available conversation has not reached a sensitive action.',
    turns:[
      {role:'caller',text:'You were selected in our customer lucky draw and may have won a prize.'},
      {role:'employee',text:'What do you need from me?'},
      {role:'caller',text:'Nothing now. The published terms are on our website.'}
    ]
  },
  {
    id:'security-warning-helpdesk',title:'Security warning with official escalation',reference:'unclear',
    summary:'A device compromise is claimed, but the caller points to the official helpdesk.',
    why:'Threat language can create fear, while refusing remote access and using an official contact supports verification.',
    turns:[
      {role:'caller',text:'Your device may be compromised by malware.'},
      {role:'employee',text:'Should I install anything?'},
      {role:'caller',text:'No. Do not grant remote access. Contact your official IT helpdesk and follow their normal procedure.'}
    ]
  }
]);

export const CASE_GROUPS=Object.freeze([
  {id:'all',label:'All cases'},
  {id:'scam-like',label:'Scam-like'},
  {id:'genuine',label:'Genuine'},
  {id:'unclear',label:'Unclear'}
]);

export function casesFor(reference='all'){
  return reference==='all'?[...CALL_CASES]:CALL_CASES.filter(item=>item.reference===reference);
}

export function caseById(id){return CALL_CASES.find(item=>item.id===id)||null;}
