import React from "react";
import { Box, Text, useStdout } from "ink";
import { pilotDeckDarkBlueTheme } from "./theme.js";

const ANSI_SHADOW_LOGO = [
  " 9999    GGGG   CCC  l               ",
  "9    9  G      C     l   aa  w     w ",
  " 99999  G  GG  C     l  a a  w  w  w ",
  "     9  G   G  C     l  a a   w w w  ",
  " 9999    GGGG   CCC  l   aa    w w   ",
];
const ANSI_SHADOW_PILOT_WIDTH = 14;
const ANSI_SHADOW_MIN_TERMINAL_COLS = 46;
const STANDARD_LOGO = ["9GClaw"];

export function PilotDeckLogo({ tagline }: { tagline?: string } = {}): React.ReactNode {
  const { stdout } = useStdout();
  const cols = stdout?.columns ?? 80;
  const useShadow = cols >= ANSI_SHADOW_MIN_TERMINAL_COLS;

  return (
    <Box flexDirection="column">
      {useShadow
        ? ANSI_SHADOW_LOGO.map((line, index) => {
            const pilot = line.slice(0, ANSI_SHADOW_PILOT_WIDTH);
            const deck = line.slice(ANSI_SHADOW_PILOT_WIDTH);
            return (
              <Text key={index}>
                <Text color={pilotDeckDarkBlueTheme.brand} bold>
                  {pilot}
                </Text>
                <Text color={pilotDeckDarkBlueTheme.brandAccent} bold>
                  {deck}
                </Text>
              </Text>
            );
          })
        : STANDARD_LOGO.map((line, index) => (
            <Text key={index} color={pilotDeckDarkBlueTheme.brandAccent} bold>
              {line}
            </Text>
          ))}
      {tagline ? (
        <Box marginTop={1}>
          <Text color={pilotDeckDarkBlueTheme.brandAccent} bold>
            {"↗  "}
          </Text>
          <Text color={pilotDeckDarkBlueTheme.subtle}>{tagline}</Text>
        </Box>
      ) : null}
    </Box>
  );
}

export function CondensedLogo(): React.ReactNode {
  return (
    <Text>
      <Text color={pilotDeckDarkBlueTheme.brand} bold>
        9G
      </Text>
      <Text color={pilotDeckDarkBlueTheme.brandAccent} bold>
        Claw
      </Text>
      <Text color={pilotDeckDarkBlueTheme.brandAccent}> ↗</Text>
    </Text>
  );
}
