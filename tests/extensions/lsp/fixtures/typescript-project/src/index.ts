import { Calculator, greet } from "./math.js";

const message = greet("Pi");
const calculator = new Calculator();
const total = calculator.add(1, 2);

console.log(message, total);
