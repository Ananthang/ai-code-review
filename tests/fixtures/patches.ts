export const CLEAN_PATCH = `@@ -10,2 +10,5 @@ export function add(a: number, b: number): number {
   return a + b;
 }
+export function multiply(a: number, b: number): number {
+  return a * b;
+}`;

export const BUGGY_PATCH = `@@ -1,3 +1,5 @@
 function processUser(user: { id: string; profile?: { email?: string } }) {
-  return user.id;
+  // Seeded bug: dereferencing profile without null check
+  const email = user.profile.email.toLowerCase();
+  return { id: user.id, email };
 }`;

export const MULTI_HUNK_PATCH = `@@ -1,3 +1,4 @@
 export const VERSION = '1.0.0';
+export const BUILD = 42;
 export const ENV = 'production';
 export const STAGE = 'prod';
@@ -20,3 +21,5 @@ export function log() {
   console.log('ready');
+  console.log('started');
+  console.log('listening');
   console.log('done');
 }`;

export const PATCH_WITH_SECRET = `@@ -1,1 +1,2 @@
 export const CONFIG = {
+  awsKey: "AKIAIOSFODNN7EXAMPLE",
 };`;

export const MALFORMED_HUNK_PATCH = `@@ -1,5 +1,10 @@
+line 1
+line 2
`; // claims 10 lines added, but only 2 present!

export const NO_NEWLINE_PATCH = `@@ -1,1 +1,2 @@
 line 1
+line 2
\\ No newline at end of file`;
