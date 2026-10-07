document.addEventListener('DOMContentLoaded', () => {
  const stkForm = document.getElementById('stkForm');
  const submitBtn = document.getElementById('submitBtn');
  const statusAlert = document.getElementById('statusAlert');
  const queryContainer = document.getElementById('queryContainer');
  const queryBtn = document.getElementById('queryBtn');

  let checkoutRequestId = null;

  const showAlert = (msg, className) => {
    statusAlert.innerText = msg;
    statusAlert.className = `status-alert ${className}`;
  };

  stkForm.addEventListener('submit', async (e) => {
    e.preventDefault();

    submitBtn.disabled = true;
    submitBtn.innerText = 'Sending Prompt...';
    queryContainer.classList.add('hidden');

    const phoneNumber = document.getElementById('phoneNumber').value;

    try {
      const response = await fetch('/api/stkpush', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phoneNumber })
      });

      const result = await response.json();

      if (result.success) {
        checkoutRequestId = result.checkoutRequestId;
        showAlert(result.message, 'info');
        queryContainer.classList.remove('hidden');
      } else {
        showAlert(result.message || 'STK Push failed.', 'error');
      }
    } catch (err) {
      showAlert('Network error sending prompt.', 'error');
    } finally {
      submitBtn.disabled = false;
      submitBtn.innerText = 'Pay Now';
    }
  });

  queryBtn.addEventListener('click', async () => {
    if (!checkoutRequestId) return;

    queryBtn.disabled = true;
    queryBtn.innerText = 'Checking...';

    try {
      const response = await fetch('/api/stkpush/query', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ checkoutRequestId })
      });

      const result = await response.json();

      if (result.success) {
        showAlert('Payment Completed Successfully!', 'success');
      } else {
        showAlert(`Status: ${result.resultDesc || 'Pending or Cancelled'}`, 'error');
      }
    } catch (err) {
      showAlert('Error checking transaction status.', 'error');
    } finally {
      queryBtn.disabled = false;
      queryBtn.innerText = 'Check Payment Status';
    }
  });
});