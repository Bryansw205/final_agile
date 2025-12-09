import { generateSchedule } from './backend/src/services/schedule.js';
const principal = 300;
const interestRate = 0.10;
const termCount = 12;
const startDate = new Date().toISOString().slice(0,10);
const sched = generateSchedule({ principal, interestRate, termCount, startDate });
const sum = (k)=> sched.reduce((a,r)=> a + Number(r[k]), 0);
const totalInstallments = sum('installmentAmount');
const totalInterest = sum('interestAmount');
const totalPrincipal = sum('principalAmount');
console.log(JSON.stringify({
  first: sched[0], last: sched[sched.length-1],
  totals: {
    totalInstallments: Number(totalInstallments.toFixed(2)),
    totalInterest: Number(totalInterest.toFixed(2)),
    totalPrincipal: Number(totalPrincipal.toFixed(2))
  },
  check: {
    principal,
    principalVsSumPrincipal: Number((principal - totalPrincipal).toFixed(2))
  }
}, null, 2));
