import { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { RiskCard } from '@/components/risk-card';
import { Screen } from '@/components/screen';
import { SensorFeedNotice } from '@/components/sensor-feed-notice';
import { SosAlert } from '@/components/sos-alert';
import { ThemedText } from '@/components/themed-text';
import { VitalsCard } from '@/components/vitals-card';
import { SENSOR_SOURCES } from '@/constants/health-data';
import { Spacing } from '@/constants/theme';
import { useAlerts } from '@/hooks/use-alerts';
import { useRiskAssessment } from '@/hooks/use-risk-assessment';
import { useSos } from '@/hooks/use-sos';
import { useRiskColors } from '@/hooks/use-theme';
import type { SensorSource } from '@/risk';
import { useSettings } from '@/settings/provider';
import { formatAge } from '@/utils/format';

function sourceLabel(source: SensorSource): string {
  return SENSOR_SOURCES.find((option) => option.key === source)?.label ?? source;
}

/** The label that must be on screen the whole time Demo mode is on. One string, used by both
 *  the pill and the section heading, so the two can never say different things. */
const DEMO_LABEL = 'Demo mode';

export default function HomeScreen() {
  // Demo-mode controls (workstream I1), rendered only while `settings.demoMode` is on — which
  // is a *persisted user choice*, not `__DEV__`, so they exist in the release APK a judge is
  // holding. That is the whole point: a control that only lives in a development bundle cannot
  // demonstrate the shipped app.
  //
  // Both arm the engine's *input* and nothing else. `simulateFall` hands `rules/fall.ts` a
  // window with a real impact-then-stillness sequence spliced into the tail; `simulateHeatWave`
  // hands `rules/heat.ts` a 44 °C / 55 % RH observation. Neither touches an assessment, a card,
  // or the SOS state on the way out, and neither is ever written to the reading store — the
  // store is only ever fed by `useSensors`' own polls, upstream of this screen
  // (`demo-mode.test.tsx` pins that). Clearing either returns that input to normal, so a flow
  // can be re-run after a cancel or a send.
  const [simulateFall, setSimulateFall] = useState(false);
  const [simulateHeatWave, setSimulateHeatWave] = useState(false);
  const risk = useRiskColors();
  const { settings } = useSettings();

  const demoMode = settings.demoMode === true;
  // Gated on `demoMode` as well as on the local state, so turning Demo mode off in Settings
  // really does return the Dashboard to real data — rather than hiding the buttons while the
  // engine quietly kept scoring a shaped input.
  const fallArmed = demoMode && simulateFall;
  const heatArmed = demoMode && simulateHeatWave;
  const demoArmed = fallArmed || heatArmed;

  const {
    assessment,
    latest,
    latestVitals,
    vitalReadingCount,
    baselines,
    live,
    feedStatus,
    feedFailure,
    requestAccess,
  } = useRiskAssessment({ simulateFall: fallArmed, simulateHeatWave: heatArmed });

  // M3 alerts: local notifications on a risk-level rise or a new critical trigger. Never on the
  // simulated window (`live`), and only with the Settings toggle on — see `useAlerts`'s own doc
  // for why both gate *planning*, not only delivery.
  //
  // `!demoArmed` extends that same rule rather than adding a new one: `live` means "these
  // readings are trustworthy real data", and an armed demo control makes that false again even
  // on a Health Connect buffer. Notifying off shaped input is precisely the failure `live`
  // exists to prevent, and a demo notification would outlive the demo — it stays in the shade
  // long after the label has left the screen.
  useAlerts({ assessment, enabled: settings.alerts.enabled, live: live && !demoArmed });

  // The engine reports critical triggers and never acts; this is the one place that hands
  // them to the module that does (PRD §7.2.5). The countdown, consent gate, and delivery all
  // live behind `useSos` — the screen only supplies the assessment and renders the overlay.
  // `latestVitals`, not `latest`: on the live feed the newest reading is the motion-only
  // summary, and the message would otherwise go out without a vitals line.
  const sos = useSos({ assessment, latest: latestVitals });

  // Freshness comes from the timestamp the engine actually evaluated, not from a
  // hand-written string, so the header cannot claim the cards are more current than they
  // are.
  const freshness =
    latest === null
      ? 'Waiting for the first reading'
      : `Updated ${formatAge(assessment.evaluatedAt - latest.timestamp)} · ${sourceLabel(latest.source)}`;

  /**
   * The always-on Demo mode label (workstream I1).
   *
   * It goes in the subtitle slot because that is already where this screen states the
   * *provenance* of everything below it — how fresh the newest reading is and which source it
   * came from — so "some of this is simulated" belongs in the same line of sight rather than in
   * a second place a reader has to know to look.
   *
   * It is a pill rather than more text appended to that line for the opposite reason: the
   * freshness line is grey secondary prose that a viewer skims past, and a label that can be
   * skimmed past is not a label. The pill carries the red foreground the risk palette uses for
   * its most serious state, and it renders whenever `demoMode` is on — not only when a control
   * is armed — because the thing a viewer must never have to infer is whether this phone is in
   * a mode where readings can be simulated at a tap.
   */
  const subtitle = demoMode ? (
    <View style={styles.subtitle}>
      <ThemedText type="small" themeColor="textSecondary">
        {freshness}
      </ThemedText>
      <View style={[styles.demoPill, { backgroundColor: risk.red.bg, borderColor: risk.red.fg }]}>
        <ThemedText type="smallBold" style={{ color: risk.red.fg }}>
          {DEMO_LABEL}
        </ThemedText>
      </View>
    </View>
  ) : (
    freshness
  );

  return (
    <Screen title="Dashboard" subtitle={subtitle}>
      {/* Both props come from the same `useRiskAssessment` memo, so the numbers and the
          averages they are compared against describe one evaluation (PRD §7.2.1 ext). */}
      <VitalsCard latest={latest} baselines={baselines} />

      {/* Only ever visible with Health Connect selected and nothing usable on screen — says
          why, and offers the one fix a tap can make (PRD §7.2.4). */}
      <SensorFeedNotice
        live={live}
        status={feedStatus}
        failure={feedFailure}
        vitalReadingCount={vitalReadingCount}
        onRequestAccess={requestAccess}
      />

      <ThemedText type="smallBold">Risk overview</ThemedText>
      {/* Levels, colours, guidance, and metrics all come from the Tier-1 rule engine
          (PRD §7.2.2) evaluating the reading buffer — `CategoryAssessment` extends the
          `RiskCategory` shape `RiskCard` already renders, so the card is unchanged. */}
      {assessment.categories.map((category) => (
        <RiskCard key={category.key} category={category} />
      ))}

      <Pressable
        accessibilityRole="button"
        onPress={sos.press}
        style={({ pressed }) => [styles.sos, pressed && styles.pressed]}>
        <ThemedText style={styles.sosTitle}>Emergency SOS</ThemedText>
        <ThemedText type="small" style={styles.sosSubtitle}>
          {sos.contacts.length === 0
            ? 'Add an emergency contact in Settings so this has somewhere to send.'
            : `Alerts ${sos.contacts.length === 1 ? 'your contact' : `your ${sos.contacts.length} contacts`} with your location and status, after a 30-second cancel window.`}
        </ThemedText>
      </Pressable>

      <SosAlert controller={sos} />

      {/* Demo mode, off by default and switched on in Settings. Each control toggles
          independently and both may be armed at once. See the comment on `simulateFall` above
          for why they inject a sensor reading / a weather observation rather than setting a
          card. */}
      {demoMode ? (
        <>
          <ThemedText type="smallBold">{DEMO_LABEL}</ThemedText>
          <DemoControl
            armed={fallArmed}
            onPress={() => setSimulateFall((armed) => !armed)}
            label="Simulate a fall"
            clearLabel="Clear simulated fall"
            hint="Splices a real impact-then-stillness sequence into the sensor window so the fall rule fires and SOS escalates. Nothing is saved to your history."
            armedHint="A 3.1 g impact followed by stillness is in the sensor window. The Fall Detection card and the SOS countdown above are the risk engine’s own response to it."
            colors={risk}
          />
          <DemoControl
            armed={heatArmed}
            onPress={() => setSimulateHeatWave((armed) => !armed)}
            label="Simulate a heat wave"
            clearLabel="Clear simulated heat wave"
            hint="Replaces the weather handed to the risk engine with 44°C at 55% humidity so the heat rule reaches its Extreme Danger band. Your real local weather is not changed, and nothing is saved to your history."
            armedHint="A simulated 44°C at 55% humidity is standing in for your local weather. The Heat Stress card above is the risk engine’s own response to it — the air quality shown is still the real reading."
            colors={risk}
          />
        </>
      ) : null}
    </Screen>
  );
}

/**
 * One demo control. Same dashed treatment the dev-only fall trigger has always had — it reads
 * as instrumentation rather than as a product affordance, which is the point.
 *
 * `armedHint` is not decoration: while a control is armed it is the only thing on screen that
 * says *which* card is looking at a simulated input and what that input was, so the Demo mode
 * pill's general warning resolves into a specific one.
 */
function DemoControl({
  armed,
  onPress,
  label,
  clearLabel,
  hint,
  armedHint,
  colors,
}: {
  armed: boolean;
  onPress: () => void;
  label: string;
  clearLabel: string;
  hint: string;
  armedHint: string;
  colors: ReturnType<typeof useRiskColors>;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: armed }}
      onPress={onPress}
      style={({ pressed }) => [
        styles.devTool,
        {
          borderColor: armed ? colors.red.fg : colors.neutral.fg,
          backgroundColor: armed ? colors.red.bg : 'transparent',
        },
        pressed && styles.pressed,
      ]}>
      <ThemedText type="smallBold" style={{ color: armed ? colors.red.fg : colors.neutral.fg }}>
        {armed ? clearLabel : label}
      </ThemedText>
      <ThemedText type="small" themeColor="textSecondary" style={styles.devToolHint}>
        {armed ? armedHint : hint}
      </ThemedText>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  sos: {
    backgroundColor: '#C1121F',
    borderRadius: Spacing.four,
    paddingVertical: Spacing.four,
    paddingHorizontal: Spacing.four,
    alignItems: 'center',
    gap: Spacing.one,
    marginTop: Spacing.two,
  },
  sosTitle: {
    color: '#ffffff',
    fontSize: 24,
    lineHeight: 30,
    fontWeight: 700,
  },
  sosSubtitle: {
    color: '#ffffff',
    opacity: 0.9,
    textAlign: 'center',
  },
  pressed: {
    opacity: 0.8,
  },
  subtitle: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: Spacing.two,
  },
  /** Solid, outlined, and in the risk palette's red — the freshness line beside it is grey
   *  secondary prose, and a label that blends into that is not a label. */
  demoPill: {
    borderWidth: 1,
    borderRadius: Spacing.two,
    paddingHorizontal: Spacing.two,
    paddingVertical: 2,
  },
  /** Dashed outline so the control reads as instrumentation rather than a product affordance. */
  devTool: {
    borderWidth: 1,
    borderStyle: 'dashed',
    borderRadius: Spacing.three,
    padding: Spacing.three,
    gap: Spacing.one,
    marginTop: Spacing.two,
  },
  devToolHint: {
    // Wraps under the label rather than beside it, so the explanation stays readable at the
    // narrow widths this sits at.
    flexShrink: 1,
  },
});
