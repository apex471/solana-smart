module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  testMatch: ["**/tests/**/*.test.ts"],
  globals: {
    "ts-jest": {
      tsconfig: {
        esModuleInterop: true,
        strict: true,
      },
    },
  },
  testTimeout: 60000,
};
