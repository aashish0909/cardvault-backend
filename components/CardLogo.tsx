// SVG card network logos rendered in white/brand colors for the card faces.
import { useId } from 'react';
import Svg, {
  Circle,
  ClipPath,
  Defs,
  G,
  Rect,
  Text as SvgText,
} from 'react-native-svg';

import { CardNetwork } from '../lib/cards';

const DEFAULT_WIDTHS: Record<CardNetwork, number> = {
  visa: 46,
  mastercard: 42,
  amex: 46,
  rupay: 44,
  discover: 54,
  diners: 56,
  unknown: 36,
};

function toNetwork(network: string): CardNetwork {
  return (network in DEFAULT_WIDTHS ? network : 'unknown') as CardNetwork;
}

export function CardLogo({
  network,
  width,
}: {
  network: string;
  width?: number;
}) {
  const n = toNetwork(network);
  const w = width ?? DEFAULT_WIDTHS[n];
  const uid = useId().replace(/[^a-zA-Z0-9]/g, '');

  switch (n) {
    case 'mastercard':
      return (
        <Svg width={w} height={(w * 30) / 48} viewBox="0 0 48 30">
          <Circle cx={16.5} cy={15} r={14} fill="#EB001B" />
          <Circle cx={31.5} cy={15} r={14} fill="#F79E1B" />
          <G clipPath={`url(#mc-${uid})`}>
            <Circle cx={16.5} cy={15} r={14} fill="#EB001B" />
          </G>
          <Defs>
            <ClipPath id={`mc-${uid}`}>
              <Rect x={24} y={0} width={24} height={30} />
            </ClipPath>
          </Defs>
        </Svg>
      );

    case 'visa':
      return (
        <Svg width={w} height={(w * 20) / 60} viewBox="0 0 60 20">
          <SvgText
            x={3}
            y={16.5}
            fontSize={18}
            fontStyle="italic"
            fontWeight="800"
            letterSpacing={1.5}
            fill="#FFFFFF"
          >
            VISA
          </SvgText>
        </Svg>
      );

    case 'amex':
      return (
        <Svg width={w} height={(w * 20) / 60} viewBox="0 0 60 20">
          <Rect
            x={1}
            y={1}
            width={58}
            height={18}
            rx={4}
            stroke="#FFFFFF"
            strokeWidth={1.5}
            fill="none"
          />
          <SvgText
            x={30}
            y={14}
            textAnchor="middle"
            fontSize={11}
            fontWeight="800"
            letterSpacing={1.5}
            fill="#FFFFFF"
          >
            AMEX
          </SvgText>
        </Svg>
      );

    case 'diners':
      return (
        <Svg width={w} height={(w * 26) / 64} viewBox="0 0 64 26">
          <Circle cx={10} cy={13} r={8} stroke="#FFFFFF" strokeWidth={2} fill="none" />
          <SvgText
            x={24}
            y={12}
            fontSize={10}
            fontWeight="800"
            letterSpacing={1.2}
            fill="#FFFFFF"
          >
            DINERS
          </SvgText>
          <SvgText
            x={24}
            y={23}
            fontSize={10}
            fontWeight="800"
            letterSpacing={1.2}
            fill="#FFFFFF"
          >
            CLUB
          </SvgText>
        </Svg>
      );

    case 'discover':
      return (
        <Svg width={w} height={(w * 20) / 66} viewBox="0 0 66 20">
          <Circle cx={10} cy={10} r={8} fill="#F76B1C" />
          <Circle cx={14} cy={7.5} r={2.6} fill="#FFFFFF" />
          <SvgText
            x={23}
            y={14}
            fontSize={11}
            fontStyle="italic"
            fontWeight="700"
            letterSpacing={1.6}
            fill="#FFFFFF"
          >
            DISCOVER
          </SvgText>
        </Svg>
      );

    case 'rupay':
      return (
        <Svg width={w} height={(w * 20) / 56} viewBox="0 0 56 20">
          <Rect
            x={2}
            y={2}
            width={11}
            height={16}
            rx={2}
            fill="#FFFFFF"
            opacity={0.25}
          />
          <SvgText
            x={20}
            y={16.5}
            fontSize={16}
            fontWeight="800"
            fill="#FFFFFF"
          >
            RuPay
          </SvgText>
        </Svg>
      );

    default:
      return (
        <Svg width={w} height={(w * 14) / 44} viewBox="0 0 44 14">
          <SvgText
            x={2}
            y={11.5}
            fontSize={11}
            fontWeight="700"
            letterSpacing={2}
            fill="rgba(255,255,255,0.75)"
          >
            CARD
          </SvgText>
        </Svg>
      );
  }
}
