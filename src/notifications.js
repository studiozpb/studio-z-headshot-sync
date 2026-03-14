function normalizeRecipients(input) {
  return String(input || "")
    .split(/[\n,]+/)
    .map((value) => value.trim())
    .filter(Boolean);
}

export function maskSecret(value) {
  if (!value) {
    return "";
  }
  if (value.length <= 6) {
    return "*".repeat(value.length);
  }
  return `${value.slice(0, 3)}${"*".repeat(value.length - 6)}${value.slice(-3)}`;
}

export function getPublicNotificationsState(state) {
  const recipients = normalizeRecipients(state.notifications.smsRecipients);
  const configured = Boolean(
    state.notifications.twilioAccountSid &&
      state.notifications.twilioAuthToken &&
      state.notifications.twilioFromNumber &&
      recipients.length,
  );

  return {
    configured,
    twilioAccountSid: state.notifications.twilioAccountSid,
    twilioAuthTokenPreview: maskSecret(state.notifications.twilioAuthToken),
    twilioFromNumber: state.notifications.twilioFromNumber,
    smsRecipients: state.notifications.smsRecipients,
    recipientsCount: recipients.length,
    notifyOnSuccess: Boolean(state.notifications.notifyOnSuccess),
    notifyOnFailure: Boolean(state.notifications.notifyOnFailure),
  };
}

function formatRunLabel(run) {
  if (run.destructive) {
    return run.source?.includes("scheduler") ? "automatic mirror" : "manual mirror";
  }
  return run.source?.includes("scheduler") ? "automatic sync" : "manual sync";
}

function buildSuccessMessage(state, run) {
  const parts = [];
  parts.push(`Studio Z sync complete: ${run.totalUploads || 0} new file${run.totalUploads === 1 ? "" : "s"} uploaded.`);

  if (state.r2.bucket) {
    const destination = `${state.r2.bucket}${state.r2.prefix ? `/${state.r2.prefix}` : ""}`;
    parts.push(`Destination: ${destination}.`);
  }

  if (state.dropbox.selectedFolderPath) {
    parts.push(`Source: ${state.dropbox.selectedFolderPath}.`);
  }

  parts.push(`Mode: ${formatRunLabel(run)}.`);
  return parts.join(" ");
}

function buildFailureMessage(state, run) {
  const parts = [];
  parts.push(`Studio Z sync failed: ${run.summary}`);

  if (state.r2.bucket) {
    const destination = `${state.r2.bucket}${state.r2.prefix ? `/${state.r2.prefix}` : ""}`;
    parts.push(`Destination: ${destination}.`);
  }

  if (state.dropbox.selectedFolderPath) {
    parts.push(`Source: ${state.dropbox.selectedFolderPath}.`);
  }

  parts.push(`Mode: ${formatRunLabel(run)}.`);
  return parts.join(" ");
}

export function shouldSendSyncNotification(state, run) {
  const notifications = getPublicNotificationsState(state);
  if (!notifications.configured) {
    return false;
  }

  if (run.outcome === "success") {
    return notifications.notifyOnSuccess && Number(run.totalUploads || 0) > 0;
  }

  if (run.outcome === "error") {
    return notifications.notifyOnFailure;
  }

  return false;
}

export async function sendSyncNotification(state, run) {
  if (!shouldSendSyncNotification(state, run)) {
    return { sent: false };
  }

  const recipients = normalizeRecipients(state.notifications.smsRecipients);
  const message =
    run.outcome === "success" ? buildSuccessMessage(state, run) : buildFailureMessage(state, run);

  const auth = Buffer.from(
    `${state.notifications.twilioAccountSid}:${state.notifications.twilioAuthToken}`,
  ).toString("base64");

  const endpoint = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(
    state.notifications.twilioAccountSid,
  )}/Messages.json`;

  for (const recipient of recipients) {
    const body = new URLSearchParams({
      To: recipient,
      From: state.notifications.twilioFromNumber,
      Body: message,
    });

    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
      },
      body,
    });

    if (!response.ok) {
      const payload = await response.text();
      throw new Error(`Twilio SMS failed (${response.status}): ${payload}`);
    }
  }

  return {
    sent: true,
    recipients: recipients.length,
  };
}
