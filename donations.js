// The Discord forms for shop items where the player types something.

const { ActionRowBuilder, ModalBuilder, TextInputBuilder, TextInputStyle } = require('discord.js');

const MESSAGE_MAX = 500;
const NOTE_MAX = 150;

const rowOf = input => new ActionRowBuilder().addComponents(input);

const amountInput = placeholder => new TextInputBuilder()
  .setCustomId('amount').setLabel('How many points?').setStyle(TextInputStyle.Short)
  .setRequired(true).setMinLength(1).setMaxLength(7).setPlaceholder(placeholder.slice(0, 100));

const form = (id, title, ...inputs) => new ModalBuilder().setCustomId(id).setTitle(title.slice(0, 45)).addComponents(inputs.map(rowOf));

const donateModal = ({ min, wallet }) => form('bh:donatemodal', 'Donate to the clan',
  amountInput(`Minimum ${min}. You have ${wallet}.`),
  new TextInputBuilder().setCustomId('message').setLabel('Message for the admin team')
    .setStyle(TextInputStyle.Paragraph).setRequired(true).setMinLength(1).setMaxLength(MESSAGE_MAX));

const giftModal = ({ toName, min, max }) => form('bh:giftmodal', `Gift to ${toName}`,
  amountInput(`${min} to ${max}`),
  new TextInputBuilder().setCustomId('note').setLabel('Note (optional, shown publicly)')
    .setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(NOTE_MAX));

const sponsorModal = ({ boss, min, max }) => form('bh:sponsormodal', `Sponsor: ${boss}`, amountInput(`${min} to ${max}`));

const duelModal = ({ toName, min, max }) => form('bh:duelmodal', `Duel ${toName}`, amountInput(`Stake: ${min} to ${max}`));

const wordModal = () => form('bh:wordmodal', "Next week's code word",
  new TextInputBuilder().setCustomId('word').setLabel('Your word (letters only, 3 to 12)')
    .setStyle(TextInputStyle.Short).setRequired(true).setMinLength(3).setMaxLength(12));

const emojiModal = () => form('bh:emojimodal', "Your winner's emoji",
  new TextInputBuilder().setCustomId('emoji').setLabel('One emoji').setStyle(TextInputStyle.Short)
    .setRequired(true).setMinLength(1).setMaxLength(64).setPlaceholder('Paste one emoji, for example 🐉'));

module.exports = { MESSAGE_MAX, NOTE_MAX, donateModal, giftModal, sponsorModal, duelModal, wordModal, emojiModal };
