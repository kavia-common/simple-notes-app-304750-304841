import { render, screen } from "@testing-library/react";
import App from "./App";

test("renders app header title", () => {
  render(<App />);
  expect(screen.getByText(/Ocean Notes/i)).toBeInTheDocument();
});

test("renders sorting control", () => {
  render(<App />);
  expect(screen.getByLabelText(/Sort/i)).toBeInTheDocument();
});
